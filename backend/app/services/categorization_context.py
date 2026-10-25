"""User-scoped evidence retrieval for transaction classification.

Labels are precedents, never merchant-wide rules. Auto-assigned labels are not
training examples. This module does not update transactions or create transfers.
"""
from __future__ import annotations

from collections import Counter, OrderedDict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import hashlib
import logging
import math
import re
from threading import RLock
from typing import Callable, Optional

from sqlalchemy import and_, case, func, or_, select

from app.models import Account, Transaction

logger = logging.getLogger(__name__)


def timestamp(value) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def direction(record: dict) -> str:
    kind = str(record.get("transaction_type") or "").lower()
    if kind in {"expense", "expenses", "debit"}:
        return "expense"
    if kind in {"income", "revenue", "credit"}:
        return "income"
    return "income" if Decimal(str(record.get("amount", 0))) > 0 else "expense"


def clean(value, limit=240) -> str:
    return " ".join(str(value or "").split())[:limit]


def metadata_text(record: dict) -> str:
    # Deliberately excludes labels, instructions and account numbers.
    return " ".join(clean(record.get(k)) for k in ("description", "merchant", "creditor", "debtor")).strip()


def terms(record: dict) -> Counter:
    words = re.findall(r"[^\W_]+", metadata_text(record).casefold(), re.UNICODE)
    stop = {"payment", "to", "from", "the", "transfer", "card", "online"}
    return Counter(word for word in words if word not in stop and not word.isdigit())


def cosine(a, b) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    norm = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    return sum(x*y for x, y in zip(a, b)) / norm if norm else 0.0


def transaction_record(tx) -> dict:
    """Only fields needed for retrieval; no encrypted identifiers leave the DB."""
    fields = ("id", "account_id", "description", "merchant", "amount", "currency",
              "transaction_type", "booked_at", "created_at", "updated_at", "creditor", "debtor",
              "category_id", "category_system_id", "category_verified_at", "categorization_instructions")
    return {key: getattr(tx, key, None) for key in fields}


def account_metadata(account) -> dict:
    """Account identity useful to the classifier, without financial identifiers."""
    get = account.get if isinstance(account, dict) else lambda key: getattr(account, key, None)
    fields = {"name": "name", "type": "account_type", "currency": "currency", "institution": "institution"}
    result = {key: clean(get(source), 100) for key, source in fields.items() if get(source)}
    if get("id") is not None:
        result["id"] = str(get("id"))
    return result


def precedent_fingerprint(row: dict) -> tuple:
    """Ignore routine refresh timestamps, but invalidate changed classification data."""
    date = timestamp(row.get("booked_at"))
    return (
        str(row.get("account_id") or ""),
        *(str(row.get(field) or "") for field in ("description", "merchant", "creditor", "debtor")),
        Decimal(str(row.get("amount", 0))), str(row.get("currency") or "").upper(),
        direction(row), date, str(row.get("categorization_instructions") or ""),
    )


def sql_direction():
    return case(
        (func.lower(Transaction.transaction_type).in_(["credit", "income", "revenue"]), "income"),
        (func.lower(Transaction.transaction_type).in_(["debit", "expense", "expenses"]), "expense"),
        (Transaction.amount > 0, "income"), else_="expense",
    )


class EmbeddingRanker:
    """Optional semantic signal; bounded process cache, separated by user/model."""

    _shared_cache = OrderedDict()
    _cache_lock = RLock()
    MAX_CACHE_ENTRIES = 4096

    def __init__(self, client_factory: Callable, model: str, *, namespace=""):
        self.client_factory = client_factory
        self.model = model
        self.namespace = namespace
        self.cache = {}
        self.tokens_used = 0
        self.failed = False

    def similarities(self, target: dict, examples: list[dict]) -> list[float]:
        texts = [metadata_text(target) or "unspecified transaction"] + [
            metadata_text(row) or "unspecified transaction" for row in examples
        ]
        if self.failed:
            return [0.0] * len(examples)
        try:
            if len(self.cache) > self.MAX_CACHE_ENTRIES:
                self.cache.clear()
            def key(text):
                return (self.namespace, self.model, hashlib.sha256(text.encode()).digest())
            with self._cache_lock:
                for text in texts:
                    cache_key = key(text)
                    if cache_key in self._shared_cache:
                        self.cache[text] = self._shared_cache[cache_key]
                        self._shared_cache.move_to_end(cache_key)
            missing = list(dict.fromkeys(text for text in texts if text not in self.cache))
            for start in range(0, len(missing), 64):
                batch = missing[start:start + 64]
                response = self.client_factory().embeddings.create(
                    model=self.model, input=batch, encoding_format="float", timeout=10.0,
                )
                vectors = {item.index: item.embedding for item in response.data}
                if set(vectors) != set(range(len(batch))):
                    raise ValueError("Incomplete embedding response")
                for i, text in enumerate(batch):
                    vector = vectors[i]
                    if not vector or not all(math.isfinite(x) for x in vector):
                        raise ValueError("Invalid embedding vector")
                    self.cache[text] = vector
                    with self._cache_lock:
                        self._shared_cache[key(text)] = vector
                        while len(self._shared_cache) > self.MAX_CACHE_ENTRIES:
                            self._shared_cache.popitem(last=False)
                self.tokens_used += response.usage.total_tokens
            return [cosine(self.cache[texts[0]], self.cache[text]) for text in texts[1:]]
        except Exception as exc:
            # Provider error messages may contain request contents: log the type only.
            logger.warning("categorizer.embeddings_unavailable error_type=%s", type(exc).__name__)
            self.failed = True
            return [0.0] * len(examples)


class CategorizationContext:
    MAX_HISTORY = 2000
    MAX_EXAMPLES = 6
    MAX_PER_CATEGORY = 2
    MAX_COUNTERPARTS = 4
    WINDOW_DAYS = 3
    MAX_RENDERED_CHARS = 6000

    def __init__(self, db, user_id: str, categories: list, *, ranker=None, examples=None, transactions=None, snapshot_path=None, accounts=(), include_counterparts=True):
        self.db = db
        self.user_id = user_id
        self.categories = {str(cat.id): cat for cat in categories if getattr(cat, "id", None)}
        self.ranker = ranker
        self.include_counterparts = include_counterparts
        self._examples = examples
        self._transactions = transactions
        self.snapshot_path = snapshot_path
        self.accounts = {str(info["id"]): info for account in accounts if (info := account_metadata(account)).get("id")}

    def examples(self) -> list[dict]:
        if self._examples is None:
            rows = (self.db.query(Transaction).filter(
                Transaction.user_id == self.user_id,
                Transaction.category_id.isnot(None),
                or_(Transaction.category_verified_at.isnot(None),
                    Transaction.category_system_id.is_(None),
                    Transaction.category_id != Transaction.category_system_id),
                Transaction.pending.is_(False),
            ).order_by(func.coalesce(Transaction.category_verified_at, Transaction.updated_at).desc(), Transaction.id).limit(self.MAX_HISTORY).all())
            self._examples = []
            for tx in rows:
                row = transaction_record(tx)
                row["verified_at"] = tx.category_verified_at or tx.updated_at
                row["provenance"] = "manual_category"
                self._examples.append(row)
            if self.snapshot_path:
                self._merge_snapshot()
        return self._examples

    def _merge_snapshot(self):
        from app.services.categorization_snapshot import read_snapshot
        try:
            snapshot = read_snapshot(self.snapshot_path, self.user_id)
            rows = sorted(snapshot["examples"], key=lambda row: (row.get("booked_at") or "", str(row["id"])), reverse=True)[:self.MAX_HISTORY]
            # A snapshot is valid only while the current effective label still
            # matches. New manual corrections always supersede snapshot decisions.
            current_rows = self.db.query(Transaction).filter(
                Transaction.user_id == self.user_id,
                Transaction.id.in_([row["id"] for row in rows]),
                Transaction.pending.is_(False),
            ).all()
            current = {str(tx.id): tx for tx in current_rows}
            manual_ids = {str(row["id"]) for row in self._examples}
            for row in rows:
                tx = current.get(str(row["id"]))
                if (str(row["id"]) not in manual_ids and tx is not None and
                    str(tx.category_id or tx.category_system_id) == str(row["category_id"]) and
                    precedent_fingerprint(transaction_record(tx)) == precedent_fingerprint(row)):
                    self._examples.append(row)
        except Exception as exc:
            logger.warning("categorizer.snapshot_unavailable error_type=%s", type(exc).__name__)

    def retrieve(self, target: dict, *, exclude_ids=(), as_of=None) -> list[dict]:
        """Relevant, diverse precedents; corrected labels are a small tie-breaker.

        as_of is an evidence-availability cutoff, NOT the transaction booking date.
        Retrospective user labels must not masquerade as historically available.
        """
        excluded = {str(x) for x in exclude_ids if x is not None}
        if target.get("id"):
            excluded.add(str(target["id"]))
        cutoff = timestamp(as_of)
        pool = []
        for row in self.examples():
            cat = self.categories.get(str(row.get("category_id")))
            if not cat or str(row.get("id")) in excluded:
                continue
            # Reviewed refunds/reversals can retain an expense category on a
            # credit (or income on a debit). Keep same-direction precedents so
            # the classifier can learn these user-specific exceptions.
            if cat.category_type not in {direction(target), "transfer"} and direction(row) != direction(target):
                continue
            verified_at = timestamp(row.get("verified_at") or row.get("updated_at"))
            if cutoff and (not verified_at or verified_at > cutoff):
                continue
            pool.append(row)
        if not pool:
            return []

        query_terms = terms(target)
        # IDF prevents ubiquitous bank boilerplate from dominating retrieval.
        documents = [terms(row) for row in pool]
        frequency = Counter(word for doc in documents for word in doc)
        idf = {word: math.log((len(pool) + 1) / (count + 1)) + 1 for word, count in frequency.items()}
        def lexical(doc):
            shared = set(query_terms) & set(doc)
            numerator = sum(query_terms[w] * doc[w] * idf.get(w, 1)**2 for w in shared)
            qnorm = math.sqrt(sum((n * idf.get(w, 1))**2 for w, n in query_terms.items()))
            dnorm = math.sqrt(sum((n * idf.get(w, 1))**2 for w, n in doc.items()))
            return numerator / (qnorm * dnorm) if qnorm and dnorm else 0.0

        semantic = self.ranker.similarities(target, pool) if self.ranker else [0.0] * len(pool)
        scored = []
        reference = cutoff or datetime.now(timezone.utc).replace(tzinfo=None)
        for row, doc, sem in zip(pool, documents, semantic):
            lex = lexical(doc)
            exact_merchant = bool(target.get("merchant")) and clean(target["merchant"]).casefold() == clean(row.get("merchant")).casefold()
            # Account/recency alone must never retrieve unrelated examples.
            if not exact_merchant and lex < 0.12 and sem < 0.55:
                continue
            score = 0.6 * lex + 0.4 * max(0.0, sem) + 0.4 * exact_merchant
            if target.get("account_id") and str(target["account_id"]) == str(row.get("account_id")):
                score += 0.08
            if target.get("currency") and target["currency"] == row.get("currency"):
                score += 0.02
            a, b = abs(Decimal(str(target.get("amount", 0)))), abs(Decimal(str(row.get("amount", 0))))
            if max(a, b) and min(a, b) / max(a, b) >= Decimal("0.8"):
                score += 0.04
            corrected = row.get("category_system_id") and str(row["category_system_id"]) != str(row["category_id"])
            score += 0.04 if corrected else 0
            verified_at = timestamp(row.get("verified_at") or row.get("updated_at"))
            if verified_at:
                score += 0.04 / (1 + max(0, (reference - verified_at).days) / 90)
            scored.append((score, str(row.get("id", "")), row))
        scored.sort(key=lambda item: (-item[0], item[1]))
        selected, counts, seen = [], Counter(), set()
        for score, _, row in scored:
            label = str(row["category_id"])
            signature = (metadata_text(row).casefold(), label, str(row.get("account_id")))
            if signature in seen or counts[label] >= self.MAX_PER_CATEGORY:
                continue
            seen.add(signature)
            counts[label] += 1
            selected.append({**row, "retrieval_score": round(score, 4)})
            if len(selected) >= self.MAX_EXAMPLES:
                break
        return selected

    def counterparts(self, target: dict, *, as_of=None) -> list[dict]:
        booked = timestamp(target.get("booked_at"))
        if not booked or not target.get("account_id") or not target.get("currency"):
            return []
        amount = abs(Decimal(str(target.get("amount", 0))))
        if amount == 0:
            return []
        if self._transactions is not None:
            candidates = self._transactions
        else:
            candidates = self._query_counterparts(target, booked, amount, as_of)
        rows = []
        cutoff = timestamp(as_of)
        for row in candidates:
            date = timestamp(row.get("booked_at"))
            created = timestamp(row.get("created_at"))
            if not date or (cutoff and (not created or created > cutoff)):
                continue
            if (str(row.get("id")) == str(target.get("id")) or
                str(row.get("account_id")) == str(target["account_id"]) or
                row.get("currency") != target["currency"] or
                abs(Decimal(str(row.get("amount", 0)))) != amount or
                direction(row) == direction(target) or
                abs(date - booked) > timedelta(days=self.WINDOW_DAYS)):
                continue
            rows.append(row)
        rows.sort(key=lambda row: (abs((timestamp(row["booked_at"]) - booked).total_seconds()), str(row["id"])))
        return rows[:self.MAX_COUNTERPARTS]

    def _query_counterparts(self, target, booked, amount, as_of):
        query = self.db.query(Transaction).join(Account, Transaction.account_id == Account.id).filter(
            Transaction.user_id == self.user_id, Account.user_id == self.user_id,
            Account.is_active.is_(True), Transaction.account_id != target["account_id"],
            Transaction.currency == target["currency"], Transaction.pending.is_(False),
            Transaction.booked_at >= booked - timedelta(days=self.WINDOW_DAYS),
            Transaction.booked_at <= booked + timedelta(days=self.WINDOW_DAYS),
            Transaction.amount.in_([amount, -amount]),
            sql_direction() != direction(target),
            Transaction.internal_transfer_id.is_(None),
            # Existing planned-expense links are unrelated; synthetic transfer mirrors
            # are identified by InternalTransfer.mirror_txn_id, not analytics flags.
            ~Transaction.id.in_(self._mirror_ids()),
            or_(Transaction.category_id.is_(None), Transaction.category_id.in_([
                cat.id for cat in self.categories.values() if cat.category_type == "transfer"
            ])),
        )
        cutoff = timestamp(as_of)
        if cutoff:
            query = query.filter(Transaction.created_at <= cutoff)
        candidates = query.order_by(func.abs(func.extract("epoch", Transaction.booked_at - booked)), Transaction.id).limit(self.MAX_COUNTERPARTS).all()
        return [transaction_record(tx) for tx in candidates]

    def reconsideration_ids(self, targets: list[dict], *, limit=50) -> list:
        """Existing unresolved rows gaining a possible counterpart in this import.

        Only genuinely uncategorised rows are reconsidered automatically. A
        reviewed choice, existing system category, hidden row or transfer link
        is never added. Queries are grouped to avoid one query per imported row.
        """
        sources = [row for row in targets if row.get("id") and row.get("account_id") and
                   row.get("currency") and row.get("booked_at") and Decimal(str(row.get("amount", 0))) != 0]
        if not sources or limit < 1:
            return []
        sources.sort(key=lambda row: (timestamp(row["booked_at"]), str(row["id"])), reverse=True)
        excluded = [row["id"] for row in sources]
        result = []
        seen = set()
        for start in range(0, len(sources), 100):
            conditions = []
            for source in sources[start:start + 100]:
                booked, amount = timestamp(source["booked_at"]), abs(Decimal(str(source["amount"])))
                conditions.append(and_(
                    Transaction.account_id != source["account_id"],
                    Transaction.currency == source["currency"],
                    Transaction.amount.in_([amount, -amount]),
                    sql_direction() != direction(source),
                    Transaction.booked_at >= booked - timedelta(days=self.WINDOW_DAYS),
                    Transaction.booked_at <= booked + timedelta(days=self.WINDOW_DAYS),
                ))
            query = self.db.query(Transaction.id).join(Account, Transaction.account_id == Account.id).filter(
                Transaction.user_id == self.user_id, Account.user_id == self.user_id,
                Account.is_active.is_(True), Transaction.category_id.is_(None),
                Transaction.category_system_id.is_(None), Transaction.pending.is_(False),
                Transaction.include_in_analytics.is_(True), Transaction.internal_transfer_id.is_(None),
                ~Transaction.id.in_(self._mirror_ids()), ~Transaction.id.in_(excluded), or_(*conditions),
            )
            if result:
                query = query.filter(~Transaction.id.in_(result))
            rows = query.order_by(Transaction.booked_at.desc(), Transaction.id).limit(limit - len(result)).all()
            for (transaction_id,) in rows:
                if str(transaction_id) not in seen:
                    seen.add(str(transaction_id))
                    result.append(transaction_id)
            if len(result) >= limit:
                break
        return result

    def _mirror_ids(self):
        from app.models import InternalTransfer
        return select(InternalTransfer.mirror_txn_id).where(
            InternalTransfer.user_id == self.user_id, InternalTransfer.mirror_txn_id.isnot(None),
        )

    def render(self, target: dict, *, exclude_ids=(), as_of=None) -> str:
        examples = self.retrieve(target, exclude_ids=exclude_ids, as_of=as_of)
        counterparts = self.counterparts(target, as_of=as_of) if self.include_counterparts else []
        counterpart_records, precedent_records = [], []
        for row in counterparts:
            counterpart_records.append({"kind": "possible_transfer_counterpart", **self._public(row),
                                        "warning": "Matching amount/time is supporting evidence, not a confirmed link."})
        for row in examples:
            accepted = self.categories[str(row["category_id"])].name
            rejected = self.categories.get(str(row.get("category_system_id")))
            item = {"kind": "verified_precedent", **self._public(row), "accepted_category": accepted,
                    "provenance": row.get("provenance", "manual_category"),
                    "guidance": clean(row.get("categorization_instructions"), 400)}
            if rejected and rejected.name != accepted:
                item["rejected_category"] = rejected.name
            precedent_records.append(item)
        # Keep both kinds of evidence represented when descriptions are verbose.
        records = []
        for index in range(max(len(counterpart_records), len(precedent_records))):
            if index < len(counterpart_records):
                records.append(counterpart_records[index])
            if index < len(precedent_records):
                records.append(precedent_records[index])
        lines, size = [], 0
        shown = Counter()
        for record in records:
            line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
            if size + len(line) + 1 > self.MAX_RENDERED_CHARS - 512:
                continue
            lines.append(line)
            size += len(line) + 1
            shown[record["kind"]] += 1
        if not lines:
            return ""
        summary = {
            "kind": "evidence_summary", "precedents_selected": len(examples),
            "precedents_shown": shown["verified_precedent"],
            "counterparts_selected": len(counterparts), "counterparts_shown": shown["possible_transfer_counterpart"],
            "counterpart_limit_reached": len(counterparts) == self.MAX_COUNTERPARTS,
        }
        return json.dumps(summary, separators=(",", ":")) + "\n" + "\n".join(lines)

    def _public(self, row):
        record = {
            "transaction_id": str(row.get("id") or ""),
            "account_id": str(row.get("account_id") or ""),
            "description": clean(row.get("description")), "merchant": clean(row.get("merchant")),
            "creditor": clean(row.get("creditor")), "debtor": clean(row.get("debtor")),
            "amount": str(row.get("amount", 0)), "currency": clean(row.get("currency"), 3),
            "type": direction(row), "booked_at": str(row.get("booked_at") or ""),
        }
        if account := self.accounts.get(str(row.get("account_id"))):
            record["account"] = account
        return record
