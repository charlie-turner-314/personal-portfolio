"""Financial facts within one selected, currently permitted record boundary.

Access, currency and economic attribution are independent. Linked peers come
only from this boundary; private or out-of-period legs are never inspected to
make a report balance. This is the backend counterpart of activity-query.ts.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, joinedload

from app.models import (
    Account,
    AccountOwnershipAllocation,
    ExchangeRate,
    HouseholdMembership,
    InternalTransfer,
    Person,
    PropertyOwnershipAllocation,
    VehicleOwnershipAllocation,
    Transaction,
    TransactionLink,
    User,
)
from app.services.financial_access import account_access
from app.services.ownership_service import (
    get_owners,
    identity_person_ids,
    resolve_shares,
)

ZERO = Decimal("0")
ONE = Decimal("1")


def decimal(value) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def reporting_date(value: str | datetime | None, *, end=False) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
        if isinstance(value, str) and len(value) == 10 and end:
            parsed = datetime.combine(parsed.date(), time.max)
        return (
            parsed.astimezone(timezone.utc).replace(tzinfo=None)
            if parsed.tzinfo
            else parsed
        )
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=422, detail="Use an ISO reporting date")


def reporting_uuid(value) -> UUID:
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=422, detail="Use a valid record identifier")


class FinancialActivity:
    def __init__(self, db: Session, actor: str, *, scope="my", person_ids=None):
        if scope not in ("my", "household") or (scope == "household" and person_ids):
            raise HTTPException(
                status_code=422,
                detail="Choose My view, Household view or selected people",
            )
        self.db, self.actor, self.scope = db, actor, scope
        self.scope_label = (
            "household"
            if scope == "household"
            else "selected_people" if person_ids else "my"
        )
        self.person_ids = (
            [reporting_uuid(value) for value in person_ids] if person_ids else None
        )
        self._shares, self._history, self._rates = {}, {}, {}
        self._currencies = {
            str(row.id): (row.functional_currency or "EUR")
            for row in db.query(User).filter(User.id == actor)
        }
        self.currency = self._currencies.get(actor, "EUR")
        self.identities, self.logins = set(), set()
        if scope == "my":
            if self.person_ids:
                ids = identity_person_ids(db, self.person_ids)
                self.identities = {str(value) for value in ids}
                for person in db.query(Person).filter(Person.id.in_(ids)):
                    login = (
                        person.user_id
                        if person.kind == "self"
                        else person.linked_user_id
                    )
                    if login:
                        self.logins.add(login)
            else:
                ids = {
                    row[0]
                    for row in db.query(Person.id).filter(
                        or_(
                            and_(Person.user_id == actor, Person.kind == "self"),
                            Person.linked_user_id == actor,
                        )
                    )
                }
                ids.update(
                    row[0]
                    for row in db.query(HouseholdMembership.person_id).filter(
                        HouseholdMembership.member_user_id == actor
                    )
                )
                self.identities = {str(value) for value in identity_person_ids(db, ids)}
                self.logins = {actor}

    def coverage(self, account_ids=None):
        selected = {reporting_uuid(value) for value in account_ids or []}
        query = self.db.query(Account).filter(account_access(Account.id, self.actor))
        if selected:
            query = query.filter(Account.id.in_(selected))
        accounts = query.order_by(Account.name, Account.id).all()
        if selected - {row.id for row in accounts}:
            raise HTTPException(
                status_code=409,
                detail="Some selected accounts are no longer available. Clear the account filter.",
            )
        return accounts

    def share(self, account, on: date, entity="account") -> Decimal:
        if self.scope == "household":
            return ONE
        key = (entity, account.id, on)
        if key not in self._shares:
            owners = get_owners(self.db, entity, account.id, on)
            if owners:
                try:
                    shares = resolve_shares(owners)
                except ValueError:
                    raise HTTPException(
                        status_code=409,
                        detail="An included account has an invalid ownership allocation",
                    )
                if any(
                    decimal(value) < ZERO or decimal(value) > ONE
                    for value in shares.values()
                ) or abs(
                    sum((decimal(value) for value in shares.values()), ZERO) - ONE
                ) > Decimal(
                    "0.0000001"
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="An included account has an incomplete ownership allocation",
                    )
                share = sum(
                    (
                        decimal(value)
                        for owner, value in shares.items()
                        if owner in self.identities
                    ),
                    ZERO,
                )
            else:
                history_key = (entity, account.id)
                if history_key not in self._history:
                    allocation = {
                        "account": AccountOwnershipAllocation,
                        "property": PropertyOwnershipAllocation,
                        "vehicle": VehicleOwnershipAllocation,
                    }[entity]
                    self._history[history_key] = (
                        self.db.query(allocation.id)
                        .filter(getattr(allocation, entity + "_id") == account.id)
                        .first()
                        is not None
                    )
                share = (
                    ONE
                    if not self._history[history_key] and account.user_id in self.logins
                    else ZERO
                )
            self._shares[key] = share
        return self._shares[key]

    def currency_for(self, user_id):
        if user_id not in self._currencies:
            row = (
                self.db.query(User.functional_currency)
                .filter(User.id == user_id)
                .first()
            )
            self._currencies[user_id] = row[0] if row and row[0] else "EUR"
        return self._currencies[user_id]

    def convert(self, amount, source: str, on: date) -> Decimal | None:
        if amount is None:
            return None
        if source == self.currency:
            return decimal(amount)
        key = (source, self.currency, on)
        if key not in self._rates:

            def rate(base, target):
                row = (
                    self.db.query(ExchangeRate.rate)
                    .filter(
                        ExchangeRate.base_currency == base,
                        ExchangeRate.target_currency == target,
                        ExchangeRate.rate > 0,
                        func.date(ExchangeRate.date) <= on,
                    )
                    .order_by(ExchangeRate.date.desc())
                    .first()
                )
                return decimal(row[0]) if row else None

            direct = rate(source, self.currency)
            inverse = rate(self.currency, source) if direct is None else None
            self._rates[key] = (
                direct if direct is not None else ONE / inverse if inverse else None
            )
        rate = self._rates[key]
        return decimal(amount) * rate if rate is not None else None

    def transaction_value(self, txn: Transaction) -> Decimal | None:
        source = self.currency_for(txn.user_id)
        if txn.currency == self.currency:
            return decimal(txn.amount)
        if source == self.currency and txn.functional_amount is not None:
            return decimal(txn.functional_amount)
        native = self.convert(txn.amount, txn.currency, txn.booked_at.date())
        return (
            native
            if native is not None
            else self.convert(txn.functional_amount, source, txn.booked_at.date())
        )

    def rows(self, *, from_date=None, to_date=None, account_ids=None):
        covered = self.coverage(account_ids)
        # Read permission again in the transaction query, not just in coverage.
        query = (
            self.db.query(Transaction)
            .options(
                joinedload(Transaction.category),
                joinedload(Transaction.category_system),
            )
            .filter(account_access(Transaction.account_id, self.actor))
        )
        if account_ids:
            query = query.filter(
                Transaction.account_id.in_(
                    [reporting_uuid(value) for value in account_ids]
                )
            )
        start, end = reporting_date(from_date), reporting_date(to_date, end=True)
        if start:
            query = query.filter(Transaction.booked_at >= start)
        if end:
            query = query.filter(Transaction.booked_at <= end)
        if start and end and end < start:
            raise HTTPException(
                status_code=422, detail="Reporting end must follow its start"
            )
        transactions = query.order_by(Transaction.booked_at, Transaction.id).all()
        ids = [txn.id for txn in transactions]
        links = (
            {
                row.transaction_id: row
                for row in self.db.query(TransactionLink).filter(
                    TransactionLink.transaction_id.in_(ids)
                )
            }
            if ids
            else {}
        )
        # Select only visible mirror identity plus group ID. No source account,
        # private peer existence, amount or ownership information is loaded.
        mirrors = (
            {
                row[0]: row[1]
                for row in self.db.query(
                    InternalTransfer.mirror_txn_id, InternalTransfer.id
                ).filter(InternalTransfer.mirror_txn_id.in_(ids))
            }
            if ids
            else {}
        )
        by_account = {row.id: row for row in covered}
        records, groups = [], defaultdict(list)
        for txn in transactions:
            automatic = txn.internal_transfer_id or mirrors.get(txn.id)
            if not txn.include_in_analytics and automatic is None:
                continue
            account = by_account.get(txn.account_id)
            if (
                account is None
            ):  # access changed since coverage; do not infer a zero report
                raise HTTPException(
                    status_code=409,
                    detail="Account coverage changed. Refresh this report.",
                )
            category = txn.category if txn.category_id else txn.category_system
            kind = txn.cash_flow_kind or (category.cash_flow_kind if category else None)
            category_type = category.category_type if category else None
            if txn.cash_flow_parts is None and kind is None and automatic:
                category_type = "transfer"
            share = self.share(account, txn.booked_at.date())
            full = self.transaction_value(txn)
            weighted = (
                ZERO if share == ZERO else full * share if full is not None else None
            )
            link = links.get(txn.id)
            generated = (txn.external_id or "").startswith("mirror-")
            validate_portions(txn.cash_flow_parts, decimal(txn.amount))
            row = {
                "id": str(txn.id),
                "account_id": str(txn.account_id),
                "date": txn.booked_at.date().isoformat(),
                "native_amount": decimal(txn.amount),
                "amount": weighted,
                "transfer_amount": weighted,
                "transfer_full_amount": full,
                "category_id": str(category.id) if category else "uncategorized",
                "category_name": category.name if category else "Uncategorized",
                "category_type": category_type,
                "color": category.color if category else None,
                "icon": category.icon if category else None,
                "cash_flow_kind": kind,
                "cash_flow_parts": txn.cash_flow_parts,
                "group_id": str(link.group_id) if link else None,
                "link_role": link.link_role if link else None,
                "automatic_id": str(automatic) if automatic else None,
                "merchant": None if generated else txn.merchant,
                "description": "Transfer" if generated else txn.description,
            }
            records.append(row)
            if link:
                groups[str(link.group_id)].append(row)
        for row in records:
            peers = groups.get(row["group_id"], [])
            row["transfer_group_id"] = (
                None
                if any(
                    peer["category_type"] != "transfer"
                    or peer["cash_flow_parts"] is not None
                    or peer["cash_flow_kind"] is not None
                    for peer in peers
                )
                else row["group_id"] or row["automatic_id"] or "unlinked:" + row["id"]
            )
            capital = lambda peer: peer["cash_flow_parts"] is not None or peer[
                "cash_flow_kind"
            ] in ("investment", "loan_principal")
            if capital(row) or any(capital(peer) for peer in peers):
                continue
            if row["link_role"] == "primary":
                row["amount"] = (
                    None
                    if any(peer["transfer_amount"] is None for peer in peers)
                    else sum((peer["transfer_amount"] for peer in peers), ZERO)
                )
            elif row["link_role"] and any(
                peer["link_role"] == "primary" for peer in peers
            ):
                row["amount"] = ZERO
        return records, [
            {"id": str(account.id), "name": account.name, "active": account.is_active}
            for account in covered
        ]

    def summarize(self, **boundary):
        rows, coverage = self.rows(**boundary)
        result = summarize_activity(rows)
        result.update(currency=self.currency, scope=self.scope_label, accounts=coverage)
        return result


def validate_portions(parts, amount):
    if parts is None:
        return
    valid = isinstance(parts, list) and 1 <= len(parts) <= 20
    total = ZERO
    if valid:
        for part in parts:
            try:
                value = decimal(part["amount"])
                valid = (
                    part["kind"] in ("income", "consumption", "capital")
                    and value.is_finite()
                    and value > ZERO
                    and value == value.quantize(Decimal("0.01"))
                    and (
                        part.get("detail") in ("investment", "loan_principal", "other")
                        if part["kind"] == "capital"
                        else part.get("detail") is None
                    )
                )
                total += value
            except (KeyError, TypeError, ValueError, ArithmeticError):
                valid = False
            if not valid:
                break
    if not valid or total != abs(amount):
        raise HTTPException(
            status_code=409,
            detail="An included transaction has invalid cash-flow portions",
        )


def default_portions(row):
    amount = abs(row["native_amount"])
    if row["cash_flow_kind"] in ("investment", "loan_principal"):
        return [{"kind": "capital", "detail": row["cash_flow_kind"], "amount": amount}]
    kind = (
        "income"
        if row["category_type"] == "income"
        else (
            "consumption"
            if row["category_type"] == "expense"
            else "income" if row["native_amount"] > ZERO else "consumption"
        )
    )
    return [{"kind": kind, "amount": amount}]


def summarize_activity(rows):
    entries, categories, daily, transfers = [], {}, {}, {}
    missing = 0
    missing_dates, unknown_entries = set(), []
    incomplete = set()
    capital = {"investment": ZERO, "loan_principal": ZERO, "other": ZERO}
    for row in rows:
        if (
            row["category_type"] == "transfer"
            and not row["cash_flow_kind"]
            and row["cash_flow_parts"] is None
        ):
            if row["transfer_group_id"] is None:
                continue
            group = transfers.setdefault(
                row["transfer_group_id"], {"net": ZERO, "full": ZERO, "legs": 0}
            )
            value = row["transfer_amount"]
            if value is None:
                missing += 1
                missing_dates.add(row["date"])
                group["net"] = None
            elif group["net"] is not None:
                group["net"] += value
            if row["transfer_full_amount"] is None:
                group["full"] = None
            elif group["full"] is not None:
                group["full"] += row["transfer_full_amount"]
            group["legs"] += 1
            continue
        if row["amount"] is None:
            missing += 1
            incomplete.add(row["category_id"])
            missing_dates.add(row["date"])
            for part in (
                row["cash_flow_parts"]
                if row["cash_flow_parts"] is not None
                else default_portions(row)
            ):
                unknown_entries.append(
                    {
                        key: row[key]
                        for key in (
                            "id",
                            "date",
                            "category_id",
                            "category_name",
                            "color",
                            "icon",
                            "merchant",
                            "description",
                        )
                    }
                    | {
                        "kind": part["kind"],
                        "detail": part.get("detail"),
                        "amount": None,
                    }
                )
            continue
        if row["amount"] == ZERO:
            continue
        if row["native_amount"] == ZERO:
            raise HTTPException(
                status_code=409,
                detail="An included transaction has inconsistent currency amounts",
            )
        for part in (
            row["cash_flow_parts"]
            if row["cash_flow_parts"] is not None
            else default_portions(row)
        ):
            signed = row["amount"] * decimal(part["amount"]) / abs(row["native_amount"])
            value = signed if part["kind"] == "income" else -signed
            entry = {
                key: row[key]
                for key in (
                    "id",
                    "account_id",
                    "date",
                    "category_id",
                    "category_name",
                    "color",
                    "icon",
                    "merchant",
                    "description",
                )
            }
            entry.update(kind=part["kind"], detail=part.get("detail"), amount=value)
            entries.append(entry)
            if part["kind"] == "capital":
                capital[part.get("detail", "other")] += value
                continue
            day = daily.setdefault(
                row["date"], {"date": row["date"], "income": ZERO, "expenses": ZERO}
            )
            day["income" if part["kind"] == "income" else "expenses"] += value
            key = (row["category_id"], part["kind"])
            category = categories.setdefault(
                key,
                {
                    "id": row["category_id"],
                    "name": row["category_name"],
                    "color": row["color"],
                    "icon": row["icon"],
                    "kind": part["kind"],
                    "amount": ZERO,
                    "transaction_ids": set(),
                    "merchants": set(),
                },
            )
            category["amount"] += value
            category["transaction_ids"].add(row["id"])
            if row["merchant"]:
                category["merchants"].add(row["merchant"])
    movement = {
        "boundary_transfers_in": ZERO,
        "boundary_transfers_out": ZERO,
        "ownership_transfers_in": ZERO,
        "ownership_transfers_out": ZERO,
    }
    for group in transfers.values():
        if group["net"] is None:
            continue
        closed = (
            group["legs"] >= 2
            and group["full"] is not None
            and abs(group["full"]) < Decimal("0.005")
        )
        key = (
            ("ownership" if closed else "boundary")
            + "_transfers_"
            + ("in" if group["net"] >= ZERO else "out")
        )
        movement[key] += abs(group["net"])
    income = sum((row["income"] for row in daily.values()), ZERO)
    expenses = sum((row["expenses"] for row in daily.values()), ZERO)
    saving = income - expenses
    transfers_in = (
        movement["boundary_transfers_in"] + movement["ownership_transfers_in"]
    )
    transfers_out = (
        movement["boundary_transfers_out"] + movement["ownership_transfers_out"]
    )
    return {
        "income": income,
        "expenses": expenses,
        "savings_from_income": saving,
        "investments": capital["investment"],
        "loan_principal": capital["loan_principal"],
        "other_capital": capital["other"],
        "transfers_in": transfers_in,
        "transfers_out": transfers_out,
        **movement,
        "explained_cash_flow": saving
        - sum(capital.values(), ZERO)
        + transfers_in
        - transfers_out,
        "missing_conversions": missing,
        "missing_dates": sorted(missing_dates),
        "unknown_entries": unknown_entries,
        "incomplete_category_ids": sorted(incomplete),
        "complete": missing == 0,
        "daily": sorted(daily.values(), key=lambda day: day["date"]),
        "categories": sorted(
            categories.values(),
            key=lambda category: (-category["amount"], category["id"]),
        ),
        "entries": entries,
    }
