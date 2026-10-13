#!/usr/bin/env python3
"""Assemble only native images that passed runtime checks in this workflow run."""
import argparse
import importlib.util
from pathlib import Path
import re

spec = importlib.util.spec_from_file_location("promotion", Path(__file__).with_name("promote-release-image.py"))
promotion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promotion)


def assemble(image, commit, directory, edge=False):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("A full commit SHA is required")
    sources = []
    for arch in ("amd64", "arm64"):
        digest = (Path(directory) / f"{arch}.txt").read_text().strip()
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError(f"Invalid {arch} digest")
        pinned = f"{image}@{digest}"
        configs = promotion.inspect(pinned, "Image")
        # Provenance-enabled single-platform exports are indexes; support a
        # plain platform manifest too, but always verify its actual CPU and SHA.
        config = configs.get(f"linux/{arch}", configs)
        if config.get("architecture") != arch or config.get("os") != "linux":
            raise ValueError(f"Wrong platform for {arch}")
        if config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != commit:
            raise ValueError(f"Wrong source revision for {arch}")
        sources.append(pinned)
    target = f"{image}:sha-{commit}"
    promotion.docker("create", "--tag", target, *sources)
    digest = promotion.inspect(target, "Manifest")["digest"]
    promotion.validate_images(promotion.inspect(f"{image}@{digest}", "Image"), commit)
    if edge:
        promotion.docker("create", "--tag", f"{image}:edge", f"{image}@{digest}")
    print(f"Verified native index {target} -> {digest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("commit")
    parser.add_argument("directory")
    parser.add_argument("--edge", action="store_true")
    args = parser.parse_args()
    assemble(args.image, args.commit, args.directory, args.edge)
