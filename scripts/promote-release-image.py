#!/usr/bin/env python3
"""Promote an exact-commit multiarch image without rebuilding its layers."""
import argparse
import json
import re
import subprocess
import time


def docker(*args):
    return subprocess.check_output(["docker", "buildx", "imagetools", *args], text=True, stderr=subprocess.PIPE, timeout=120)


def inspect(ref, field):
    return json.loads(docker("inspect", ref, "--format", "{{json ." + field + "}}"))


def validate_images(images, commit):
    for platform in ("linux/amd64", "linux/arm64"):
        config = images.get(platform, {})
        if config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != commit:
            raise ValueError(f"Missing or incorrect revision for {platform}")


def promote(image, commit, tag, wait_seconds=1200):
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Expected full commit SHA and stable vX.Y.Z tag")
    source = f"{image}:sha-{commit}"
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            manifest = inspect(source, "Manifest")
            break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if time.monotonic() >= deadline:
                raise RuntimeError("Exact-commit image unavailable; refusing to rebuild a release") from None
            print("Waiting for the branch build to publish the exact commit...", flush=True)
            time.sleep(min(30, max(0, deadline - time.monotonic())))
    digest = manifest["digest"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("Invalid source digest")
    pinned = f"{image}@{digest}"
    validate_images(inspect(pinned, "Image"), commit)
    destination = f"{image}:{tag}"
    try:
        existing = inspect(destination, "Manifest")
    except subprocess.CalledProcessError as error:
        # Auth/network failures must fail closed, not masquerade as an absent tag.
        if "not found" not in (error.stderr or "").lower() and "manifest unknown" not in (error.stderr or "").lower():
            raise
        existing = None
    if existing is not None and existing["digest"] != digest:
        raise ValueError("Release tag already exists with a different digest; refusing to overwrite")
    if existing is None:
        docker("create", "--tag", destination, pinned)
    if inspect(destination, "Manifest")["digest"] != digest:
        raise ValueError("Published release digest differs from the verified source")
    print(f"Verified {destination} -> {digest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("commit")
    parser.add_argument("tag")
    args = parser.parse_args()
    promote(args.image, args.commit, args.tag)
