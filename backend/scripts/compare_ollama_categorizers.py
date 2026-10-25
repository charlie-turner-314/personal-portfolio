#!/usr/bin/env python3
"""Sequential local model comparison, frozen labels, private per-split checkpoints."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import threading
import time

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.categorization_evaluation import evaluate_snapshot, evaluation_matcher, evaluation_targets, split_examples
from app.services.categorization_snapshot import read_snapshot
from app.services.category_matcher import CategoryMatcher


def private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, indent=2)


def sysctl(name):
    return subprocess.check_output(["sysctl", "-n", name], text=True, stderr=subprocess.DEVNULL).strip()


def memory_sample(endpoint):
    models = httpx.get(endpoint + "/api/ps", timeout=5).json()["models"]
    sample = {"models": [{key: model.get(key) for key in ("name", "size", "size_vram", "context_length")} for model in models]}
    if sys.platform == "darwin":
        sample["pressure_level"] = int(sysctl("kern.memorystatus_vm_pressure_level"))
        swap = re.search(r"used\s*=\s*([\d.]+)([MG])", sysctl("vm.swapusage"))
        sample["swap_used_mib"] = float(swap[1]) * (1024 if swap[2] == "G" else 1) if swap else None
    return sample


class MemoryMonitor:
    def __init__(self, endpoint):
        self.endpoint, self.samples, self.stop = endpoint, [], threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            try:
                self.samples.append({"at": time.time(), **memory_sample(self.endpoint)})
            except Exception as error:
                self.samples.append({"at": time.time(), "error_type": type(error).__name__})
            self.stop.wait(2)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stop.set()
        self.thread.join(timeout=6)


def summarize_memory(samples):
    allocations = [sum(model.get("size_vram", 0) or 0 for model in sample.get("models", [])) for sample in samples]
    pressures = [sample["pressure_level"] for sample in samples if "pressure_level" in sample]
    swaps = [sample["swap_used_mib"] for sample in samples if sample.get("swap_used_mib") is not None]
    return {"peak_ollama_gpu_allocation_gib": max(allocations, default=0) / 1024**3,
            "max_pressure_level": max(pressures) if pressures else None,
            "swap_start_mib": swaps[0] if swaps else None,
            "swap_end_mib": swaps[-1] if swaps else None,
            "swap_peak_increase_mib": max(swaps) - swaps[0] if swaps else None,
            "note": "Ollama allocation is not whole-system resident memory. Pressure/swap are system-wide and include other apps."}


def interactive_trial(snapshot, model, count):
    train, held_out = split_examples(snapshot, split="temporal", limit=50)
    targets = evaluation_targets(held_out)
    selected = [targets[(index * len(targets)) // count] for index in range(count)]
    matcher = evaluation_matcher(snapshot, train, mode="examples_only")
    calls = []
    for target in selected:
        results, tokens, _ = matcher.match_categories_batch_llm([target], max_batch_size=1)
        if not tokens or matcher.last_batch_failures:
            raise RuntimeError("Interactive model request did not complete")
        calls.append({"assigned": bool(results), **matcher._get_openai_client().request_metrics[-1]})
    durations = [call["wall_seconds"] for call in calls]
    return {"model": model, "context_tokens": int(os.environ["CATEGORIZER_OLLAMA_CONTEXT"]),
            "count": count, "requests": calls, "median_seconds": statistics.median(durations),
            "median_after_first_seconds": statistics.median(durations[1:]) if len(durations) > 1 else None,
            "first_request_seconds": durations[0],
            "note": "Five evenly spaced held-out targets, one at a time. First request includes changing context allocation; no user reviews."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--models", nargs="+", default=["qwen3:8b", "qwen3.5:9b-q4_K_M", "qwen3.5:4b-q4_K_M"])
    parser.add_argument("--splits", nargs="+", choices=["temporal", "merchant", "transfer"], default=["temporal", "merchant", "transfer"])
    parser.add_argument("--context", type=int, default=32768)
    parser.add_argument("--interactive-context", type=int, default=8192)
    parser.add_argument("--interactive-samples", type=int, default=5)
    args = parser.parse_args()
    if args.output_dir.exists():
        parser.error("Output directory already exists; preserve completed checkpoints")
    if not 1 <= args.interactive_samples <= 50:
        parser.error("Interactive sample count must be between 1 and 50")
    endpoint = os.getenv("CATEGORIZER_OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    tags = {model["name"]: model for model in httpx.get(endpoint + "/api/tags").json()["models"]}
    if any(model not in tags for model in args.models):
        parser.error("Every requested model must already be installed")
    if httpx.get(endpoint + "/api/ps").json()["models"]:
        parser.error("A model is already loaded; do not evict unrelated inference work")
    snapshot = read_snapshot(args.snapshot)
    args.output_dir.mkdir(parents=True, mode=0o700)
    os.environ["CATEGORIZER_PROVIDER"] = "ollama"
    # No changes to provider files, model aliases, or production configuration.
    manifest = {"snapshot_sha256": hashlib.sha256(args.snapshot.read_bytes()).hexdigest(),
                "provider_version": httpx.get(endpoint + "/api/version").json(),
                "models": [tags[model] for model in args.models], "splits": args.splits,
                "context_tokens": args.context, "interactive_context_tokens": args.interactive_context,
                "mode": "examples_only", "temperature": CategoryMatcher.LLM_TEMPERATURE, "seed": 42,
                "hardware": {"model": sysctl("hw.model"), "memory_bytes": int(sysctl("hw.memsize")), "chip": sysctl("machdep.cpu.brand_string")} if sys.platform == "darwin" else {},
                "baseline_memory": memory_sample(endpoint),
                "source_sha256": {name: hashlib.sha256((Path(__file__).resolve().parents[1] / name).read_bytes()).hexdigest() for name in
                                  ("app/services/category_matcher.py", "app/services/categorization_context.py", "app/services/ollama_categorizer.py")}}
    private_json(args.output_dir / "manifest.json", manifest)
    for model in args.models:
        print(json.dumps({"model": model, "stage": "starting"}), flush=True)
        CategoryMatcher.LLM_MODEL = model
        slug = re.sub(r"[^a-zA-Z0-9_-]", "_", model)
        show = httpx.post(endpoint + "/api/show", json={"model": model}, timeout=30).json()
        private_json(args.output_dir / f"{slug}-identity.json", {key: show.get(key) for key in ("details", "model_info", "parameters", "capabilities")})
        with MemoryMonitor(endpoint) as monitor:
            try:
                for split in args.splits:
                    os.environ["CATEGORIZER_OLLAMA_CONTEXT"] = str(args.context)
                    print(json.dumps({"model": model, "split": split, "stage": "running"}), flush=True)
                    report = evaluate_snapshot(snapshot, split=split, modes=("examples_only",), run=True)
                    private_json(args.output_dir / f"{slug}-{split}.json", report)
                    metrics = report["modes"]["examples_only"]
                    print(json.dumps({"model": model, "split": split, "correct": metrics["correct"], "total": metrics["total"], "abstained": metrics["abstained"]}), flush=True)
                os.environ["CATEGORIZER_OLLAMA_CONTEXT"] = str(args.interactive_context)
                interactive = interactive_trial(snapshot, model, args.interactive_samples)
                private_json(args.output_dir / f"{slug}-interactive.json", interactive)
                print(json.dumps({"model": model, "interactive_median_seconds": interactive["median_seconds"]}), flush=True)
            except Exception as error:
                private_json(args.output_dir / f"{slug}-failure.json", {"error_type": type(error).__name__})
                print(json.dumps({"model": model, "failed": type(error).__name__}), flush=True)
            finally:
                # Unload only the model this experiment loaded, before the next.
                httpx.post(endpoint + "/api/generate", json={"model": model, "keep_alive": 0}, timeout=60).raise_for_status()
        private_json(args.output_dir / f"{slug}-memory.json", {"summary": summarize_memory(monitor.samples), "samples": monitor.samples})


if __name__ == "__main__":
    main()
