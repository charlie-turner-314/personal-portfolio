#!/usr/bin/env python3
"""Exercise production image entry points without credentials or network."""
import json
import subprocess
import sys

service, image = sys.argv[1:]


def run(*args, payload=""):
    return subprocess.run(["docker", "run", "--rm", "--network=none", "-i", "--entrypoint", "node", image, *args], input=payload, capture_output=True, text=True, timeout=60)


if service == "backend":
    payload = {"report_name": "Image smoke report", "generated_at": "2026-10-11T00:00:00Z", "accounts": [], "transactions": {"mode_label": "Recent", "items": []}, "manage_url": "https://example.test/reports"}
    result = run("/frontend/render-report.cjs", payload=json.dumps(payload))
    assert result.returncode == 0, result.stderr
    rendered = json.loads(result.stdout)
    assert "Image smoke report" in rendered["html"] and "Image smoke report" in rendered["text"]
    assert run("/frontend/render-report.cjs", payload="bad json").returncode != 0
    assert run("/frontend/render-report.cjs", payload="{}").returncode != 0
else:
    result = run("scripts/migrate.js")
    assert result.returncode != 0 and "DATABASE_URL is required" in result.stderr, result.stderr
    result = run("--check", "server.js")
    assert result.returncode == 0, result.stderr
print(f"{service}: offline runtime smoke passed")
