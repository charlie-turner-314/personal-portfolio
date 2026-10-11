#!/usr/bin/env python3
"""List obsolete portfolio version tags; --apply removes only the listed tags.

Run only after health/login/data checks pass. Always retain current and previous.
Never prunes volumes, build caches, edge tags, or another application's images.
"""
import argparse
import json
import re
import subprocess

REPOSITORIES = {f"ghcr.io/charlie-turner-314/personal-portfolio-{service}" for service in ("frontend", "backend")}


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True)


def candidates(rows, keep_tags, protected_ids):
    return sorted({f'{row["Repository"]}:{row["Tag"]}' for row in rows
                   if row["Repository"] in REPOSITORIES
                   and re.fullmatch(r"v\d+\.\d+\.\d+", row["Tag"])
                   and row["Tag"] not in keep_tags and row["ID"] not in protected_ids})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("current")
    parser.add_argument("previous")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.current == args.previous or not all(re.fullmatch(r"v\d+\.\d+\.\d+", t) for t in (args.current, args.previous)):
        parser.error("Supply distinct immutable current and previous version tags")
    protected = set()
    for repo in REPOSITORIES:
        for tag in (args.current, args.previous):
            protected.add(docker("image", "inspect", f"{repo}:{tag}", "--format", "{{.Id}}").strip())
    containers = docker("ps", "-aq").split()
    if containers:
        protected.update(c["Image"] for c in json.loads(docker("inspect", *containers)))
    rows = [json.loads(line) for line in docker("image", "ls", "--no-trunc", "--format", "{{json .}}").splitlines()]
    selected = candidates(rows, {args.current, args.previous}, protected)
    for ref in selected:
        print(("Removing " if args.apply else "Would remove ") + ref, flush=True)
        if args.apply:
            # No force: Docker also protects images referenced by containers.
            subprocess.run(["docker", "image", "rm", ref], check=True)
    print(f"{len(selected)} obsolete version tags {'removed' if args.apply else 'selected (dry run)'}; volumes untouched.")


if __name__ == "__main__":
    main()
