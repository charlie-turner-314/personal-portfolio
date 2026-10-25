#!/usr/bin/env python3
"""Export verified history or compare contextual classification on a frozen holdout."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="Read-only, private snapshot of one user's history")
    export.add_argument("--user-id", required=True)
    export.add_argument("--output", required=True, type=Path)
    export.add_argument("--trust-current-labels", action="store_true", help="Attest that this user's current effective categories have been reviewed")
    evaluate = commands.add_parser("evaluate", help="Evaluate without modifying transactions")
    evaluate.add_argument("snapshot", type=Path)
    evaluate.add_argument("--output", required=True, type=Path)
    evaluate.add_argument("--limit", type=int, default=50)
    evaluate.add_argument("--split", choices=["temporal", "merchant", "transfer"], default="temporal")
    evaluate.add_argument("--semantic", action="store_true")
    evaluate.add_argument("--ablation", action="store_true", help="Compare reviewed examples alone against examples plus counterpart context")
    evaluate.add_argument("--modes", nargs="+", choices=["without_retrieval", "examples_only", "contextual", "semantic"], help="Explicit comparison arms")
    evaluate.add_argument("--run", action="store_true", help="Send holdout transactions/context to the configured model; incurs API usage")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output already exists; choose a new path before running an evaluation")
    if args.command == "export":
        from app.database import SessionLocal
        from app.services.categorization_snapshot import export_snapshot
        with SessionLocal() as db:
            counts = export_snapshot(db, args.user_id, args.output, trust_current_labels=args.trust_current_labels)
        print(json.dumps(counts))
    else:
        from app.services.categorization_snapshot import read_snapshot
        from app.services.categorization_evaluation import evaluate_snapshot, report_summary
        snapshot = read_snapshot(args.snapshot)
        modes = ("examples_only", "contextual") if args.ablation else ("without_retrieval", "contextual")
        if args.semantic:
            modes += ("semantic",)
        if args.modes:
            modes = tuple(dict.fromkeys(args.modes))
        report = evaluate_snapshot(snapshot, limit=args.limit, split=args.split, modes=modes, run=args.run)
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(report, stream, indent=2)
        # Aggregate counts/metrics only. Transaction metadata never goes to stdout.
        print(json.dumps(report_summary(report), indent=2))


if __name__ == "__main__":
    main()
