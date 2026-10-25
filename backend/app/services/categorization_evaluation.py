"""Offline-snapshot holdout evaluation. Does not connect to or write a database."""
from collections import Counter
import hashlib
import json
import os
import random
import re
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

from app.services.categorization_context import CategorizationContext, EmbeddingRanker, clean, timestamp
from app.services.category_matcher import CategoryMatcher


def split_examples(snapshot, *, test_fraction=0.2, split="temporal", limit=50):
    if not 0 < test_fraction < 1 or limit < 1:
        raise ValueError("Invalid holdout fraction or limit")
    rows = sorted(snapshot["examples"], key=lambda row: (timestamp(row["booked_at"]), str(row["id"])))
    if len(rows) < 5:
        raise ValueError("At least five verified examples are required")
    if split == "transfer":
        return transfer_split(snapshot, limit=limit)
    if split == "temporal":
        boundary = max(1, min(len(rows) - 1, int(len(rows) * (1 - test_fraction))))
        train, test = rows[:boundary], rows[boundary:]
    elif split == "merchant":
        groups = sorted({merchant_key(row) for row in rows}, key=lambda key: hashlib.sha256(key.encode()).hexdigest())
        if len(groups) < 2:
            raise ValueError("Merchant holdout requires at least two merchant groups")
        test_groups = set(groups[:max(1, min(len(groups) - 1, round(len(groups) * test_fraction)))])
        train = [row for row in rows if merchant_key(row) not in test_groups]
        test = [row for row in rows if merchant_key(row) in test_groups]
    else:
        raise ValueError("Unknown split")
    # Evaluate a deterministic evenly-spaced sample, rather than only the last
    # merchant in a clustered bank export. ALL holdout labels stay excluded.
    if len(test) > limit:
        test = [test[(i * len(test)) // limit] for i in range(limit)]
    return train, test


def merchant_key(row):
    return clean(row.get("merchant") or row.get("creditor") or row.get("debtor") or row.get("description"), 400).casefold()


def transfer_strata(snapshot):
    """Select a challenge set from reviewed labels, before any model predictions."""
    matcher = evaluation_matcher(snapshot, [])
    types = {str(cat["id"]): cat["category_type"] for cat in snapshot["categories"]}
    strata = {}
    for row in snapshot["examples"]:
        counterpart = bool(matcher._context_retriever.counterparts(row))
        if types[str(row["category_id"])] == "transfer":
            group = "transfer_with_counterpart" if counterpart else "transfer_without_counterpart"
        elif counterpart:
            group = "nontransfer_with_counterpart"
        elif re.search(r"\b(refund|refunded|reversal|reversed|reimbursement|chargeback)\b", str(row.get("description", "")), re.I):
            group = "nontransfer_refund"
        elif re.search(r"\b(transfer|payment|bpay|osko|payid)\b", str(row.get("description", "")), re.I):
            group = "nontransfer_transfer_language"
        else:
            group = "nontransfer_control"
        strata[str(row["id"])] = group
    return strata


def transfer_split(snapshot, *, limit=50):
    strata = transfer_strata(snapshot)
    groups = {}
    for row in snapshot["examples"]:
        groups.setdefault(strata[str(row["id"])], []).append(row)
    for rows in groups.values():
        rows.sort(key=lambda row: hashlib.sha256(str(row["id"]).encode()).hexdigest())
    # Balanced round-robin; do not let abundant ordinary purchases swamp lookalikes.
    test = []
    for index in range(8):
        for group in sorted(groups):
            if index < len(groups[group]) and len(test) < limit:
                test.append(groups[group][index])
    test_ids = {str(row["id"]) for row in test}
    def related_event(row):
        return any(row.get("currency") == target.get("currency")
                   and abs(Decimal(str(row["amount"]))) == abs(Decimal(str(target["amount"])))
                   and abs(timestamp(row["booked_at"]) - timestamp(target["booked_at"])) <= timedelta(days=3)
                   for target in test)
    # Also hide labels of other legs of the same event. Their raw metadata remains
    # available as counterpart evidence, but their reviewed answer cannot leak.
    train = [row for row in snapshot["examples"] if str(row["id"]) not in test_ids and not related_event(row)]
    return train, test


def transfer_metrics(test, predictions, snapshot):
    types = {str(cat["id"]): cat["category_type"] for cat in snapshot["categories"]}
    counts = Counter({key: 0 for key in ("true_positive", "false_positive", "false_negative", "true_negative", "abstained_positive", "abstained_negative")})
    for index, row in enumerate(test):
        expected = types[str(row["category_id"])] == "transfer"
        prediction = predictions.get(index)
        predicted = bool(prediction and types[str(prediction[0].id)] == "transfer")
        counts["true_positive" if expected and predicted else "false_negative" if expected else "false_positive" if predicted else "true_negative"] += 1
        if not prediction:
            counts["abstained_positive" if expected else "abstained_negative"] += 1
    tp, fp, fn = counts["true_positive"], counts["false_positive"], counts["false_negative"]
    return {**counts, "precision": tp / (tp + fp) if tp + fp else None,
            "recall": tp / (tp + fn) if tp + fn else None,
            "note": "Abstentions count as not predicting transfer; this tests category choice, not confirmed transfer links."}


class NoDatabase:
    def query(self, *args, **kwargs):
        raise RuntimeError("Evaluation must not query a live database")


def evaluation_matcher(snapshot, train, *, mode="contextual"):
    if mode not in {"without_retrieval", "examples_only", "contextual", "semantic"}:
        raise ValueError("Unknown evaluation mode")
    categories = [SimpleNamespace(**row) for row in snapshot["categories"]]
    matcher = CategoryMatcher(NoDatabase(), user_id=snapshot["user_id"], auto_load_from_db=False)
    matcher._category_cache = {cat.name.lower(): cat for cat in categories}
    matcher._account_cache = [SimpleNamespace(**{**row, "external_id": None}) for row in snapshot["accounts"]]
    matcher.additional_instructions = [f"For category '{c.name}': {c.categorization_instructions}" for c in categories if getattr(c, "categorization_instructions", None)]
    matcher.context_enabled = mode != "without_retrieval"
    ranker = None
    if mode == "semantic":
        import os
        model = os.getenv("CATEGORIZER_EMBEDDING_MODEL", "text-embedding-3-small") or "text-embedding-3-small"
        ranker = EmbeddingRanker(matcher._get_openai_client, model, namespace=snapshot["user_id"])
    matcher._context_retriever = CategorizationContext(
        NoDatabase(), snapshot["user_id"], categories,
        examples=train, transactions=snapshot["transactions"], ranker=ranker, accounts=snapshot["accounts"],
        include_counterparts=mode != "examples_only",
    )
    return matcher


def evaluation_targets(test):
    fields = {"id", "account_id", "description", "merchant", "amount", "currency", "transaction_type",
              "booked_at", "created_at", "updated_at", "creditor", "debtor"}
    return [{**{k: v for k, v in row.items() if k in fields}, "index": i} for i, row in enumerate(test)]


def summarize_predictions(test, results, train):
    counts = Counter({key: 0 for key in (
        "correct", "incorrect", "abstained", "familiar_merchant_total", "familiar_merchant_correct",
        "unseen_merchant_total", "unseen_merchant_correct",
    )})
    scored = []
    merchants = {merchant_key(row) for row in train}
    for index, expected in enumerate(test):
        result = results.get(index)
        correct = bool(result and str(result[0].id) == str(expected["category_id"]))
        counts["correct" if correct else "incorrect" if result else "abstained"] += 1
        group = "familiar_merchant" if merchant_key(expected) in merchants else "unseen_merchant"
        counts[group + "_total"] += 1
        counts[group + "_correct"] += int(correct)
        if result and result[1] is not None:
            scored.append((result[1] / 100, correct))
    assigned = counts["correct"] + counts["incorrect"]
    thresholds = []
    for threshold in (0, .5, .75, .9, .95):
        subset = [(score, correct) for score, correct in scored if score >= threshold]
        thresholds.append({"threshold": threshold, "count": len(subset),
                           "accuracy": sum(ok for _, ok in subset) / len(subset) if subset else None})
    bins = []
    for low in range(0, 100, 10):
        subset = [(score, ok) for score, ok in scored if low / 100 <= score and (score < (low + 10) / 100 or low == 90)]
        bins.append({"lower": low / 100, "count": len(subset),
                     "mean_score": sum(score for score, _ in subset) / len(subset) if subset else None,
                     "accuracy": sum(ok for _, ok in subset) / len(subset) if subset else None})
    ece = sum(b["count"] * abs(b["mean_score"] - b["accuracy"]) for b in bins if b["count"]) / len(scored) if scored else None
    return {
        **counts, "total": len(test), "coverage": assigned / len(test) if test else 0,
        "accuracy_all": counts["correct"] / len(test) if test else None,
        "accuracy_assigned": counts["correct"] / assigned if assigned else None,
        "scored_count": len(scored), "scores_are_calibrated": False,
        "score_brier": sum((score - correct)**2 for score, correct in scored) / len(scored) if scored else None,
        "score_ece": ece, "reliability_bins": bins, "thresholds": thresholds,
    }


def paired_comparison(test, baseline, candidate):
    """Paired accuracy change; bootstrap whole merchants to retain repeat dependence."""
    groups = {}
    fixed = regressed = both_correct = 0
    for index, expected in enumerate(test):
        def correct(predictions):
            result = predictions.get(index)
            return bool(result and str(result[0].id) == str(expected["category_id"]))
        before, after = correct(baseline), correct(candidate)
        fixed += int(after and not before)
        regressed += int(before and not after)
        both_correct += int(before and after)
        groups.setdefault(merchant_key(expected), []).append(int(after) - int(before))
    clusters = list(groups.values())
    interval = None
    if len(clusters) >= 2:
        rng = random.Random(42)
        samples = []
        for _ in range(1000):
            selected = rng.choices(clusters, k=len(clusters))
            samples.append(sum(sum(group) for group in selected) / sum(len(group) for group in selected))
        samples.sort()
        interval = [samples[24], samples[974]]
    return {
        "count": len(test), "merchant_groups": len(clusters), "fixed": fixed, "regressed": regressed,
        "both_correct": both_correct, "both_not_correct": len(test) - fixed - regressed - both_correct,
        "accuracy_all_change": (fixed - regressed) / len(test) if test else None,
        "accuracy_change_ci95": interval, "interval_method": "merchant-cluster bootstrap, 1000 draws, seed 42",
        "interval_is_descriptive": True,
    }


def prediction_audit(result, evidence=""):
    records = [json.loads(line) for line in evidence.splitlines() if line.strip()]
    return {
        "category_id": str(result[0].id) if result else None,
        "category_name": result[0].name if result else None,
        "model_score": result[1] if result else None,
        "precedent_ids": [row["transaction_id"] for row in records if row.get("kind") == "verified_precedent"],
        "counterpart_ids": [row["transaction_id"] for row in records if row.get("kind") == "possible_transfer_counterpart"],
    }


def report_summary(report):
    """The private artifact keeps case IDs; terminal output contains aggregates only."""
    return {key: value for key, value in report.items() if key != "cases"}


def evaluate_snapshot(snapshot, *, limit=50, split="temporal", modes=("without_retrieval", "contextual"), run=False):
    if run and "semantic" in modes and os.getenv("CATEGORIZER_PROVIDER", "openai") == "ollama":
        raise ValueError("The Ollama transport currently supports chat only; semantic evaluation requires an embedding provider")
    train, test = split_examples(snapshot, split=split, limit=limit)
    targets = evaluation_targets(test)
    report = {
        "snapshot_at": snapshot["snapshot_at"], "split": split, "train_count": len(train), "test_count": len(test),
        "evaluation_kind": "retrospective holdout; snapshot verification is not claimed to predate booking",
        "live_calls": run, "modes": {},
        "cases": [{"transaction_id": str(row["id"]), "expected_category_id": str(row["category_id"]), "predictions": {}} for row in test],
    }
    if split == "transfer":
        strata = transfer_strata(snapshot)
        report["challenge_strata"] = dict(Counter(strata[str(row["id"])] for row in test))
        report["selection"] = "Deterministic stratified challenge, max 8 per stratum; not a population accuracy estimate. Same-event labels excluded."
    baseline_matcher = evaluation_matcher(snapshot, train)
    categories = {str(cat.id): cat for cat in baseline_matcher._category_cache.values()}
    nearest = {}
    for target in targets:
        precedents = baseline_matcher._context_retriever.retrieve(target)
        if precedents:
            nearest[target["index"]] = (categories[str(precedents[0]["category_id"])], None)
    report["retrieval_baseline"] = {
        "description": "Top retrieved precedent; no LLM calls and no probability scores",
        **summarize_predictions(test, nearest, train),
    }
    for index, case in enumerate(report["cases"]):
        case["predictions"]["retrieval_baseline"] = prediction_audit(nearest.get(index))
    predictions_by_mode = {}
    for mode in modes:
        matcher = evaluation_matcher(snapshot, train, mode=mode)
        if run:
            if not matcher._get_openai_client():
                raise ValueError("A configured model provider is required for live evaluation")
            predictions, tokens, cost = matcher.match_categories_batch_llm(targets, max_batch_size=10)
            if tokens == 0 or matcher.last_batch_failures:
                raise RuntimeError("Missing model responses; evaluation is incomplete")
            metrics = summarize_predictions(test, predictions, train)
            if split == "transfer":
                metrics["transfer_detection"] = transfer_metrics(test, predictions, snapshot)
                metrics["transfer_by_stratum"] = {}
                for group in sorted(set(strata[str(row["id"])] for row in test)):
                    indices = [index for index, row in enumerate(test) if strata[str(row["id"])] == group]
                    metrics["transfer_by_stratum"][group] = transfer_metrics(
                        [test[index] for index in indices],
                        {local: predictions[index] for local, index in enumerate(indices) if index in predictions}, snapshot)
            metrics.update(tokens=tokens, chat_cost_usd=cost)
            client = matcher._get_openai_client()
            if isinstance(getattr(client, "request_metrics", None), list):
                metrics["requests"] = list(client.request_metrics)
            predictions_by_mode[mode] = predictions
        else:
            # Preparation must not accidentally make embedding or model API calls.
            matcher._context_retriever.ranker = None
            excluded = [target["id"] for target in targets]
            for target in targets:
                matcher._evidence_block(target, excluded)
            metrics = {"targets_with_evidence": sum(bool(value) for value in matcher.last_context.values())}
        ranker = matcher._context_retriever.ranker
        metrics["embedding_tokens"] = ranker.tokens_used if ranker else 0
        metrics["model"] = matcher.LLM_MODEL
        metrics["provider"] = os.getenv("CATEGORIZER_PROVIDER", "openai")
        if metrics["provider"] == "ollama":
            metrics["context_tokens"] = int(os.getenv("CATEGORIZER_OLLAMA_CONTEXT", "32768"))
            metrics["seed"] = 42
            metrics["thinking"] = False
        metrics["temperature"] = matcher.LLM_TEMPERATURE
        report["modes"][mode] = metrics
        for index, case in enumerate(report["cases"]):
            case["predictions"][mode] = prediction_audit(
                predictions_by_mode.get(mode, {}).get(index), matcher.last_context.get(index, ""),
            )
    report["paired_comparisons"] = {}
    for baseline in ("without_retrieval", "examples_only"):
        if baseline in predictions_by_mode:
            for mode, predictions in predictions_by_mode.items():
                if mode != baseline and (baseline != "examples_only" or mode == "contextual"):
                    key = mode if baseline == "without_retrieval" else "contextual_vs_examples_only"
                    report["paired_comparisons"][key] = paired_comparison(test, predictions_by_mode[baseline], predictions)
    return report
