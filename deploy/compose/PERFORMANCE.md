# End-to-end delivery performance

This is an evidence ledger and decision record, not a speed guarantee. Human review
and acceptance time is excluded from the machine-time estimates below.

## Baseline (v0.1.3, 2026-10-11)

| Stage | Measured duration | Evidence |
| --- | ---: | --- |
| PR tests / container validation | ~3–4 min, parallel | PR #36 checks |
| Develop multiarch publication, cold cache | 16m 10s | Actions run 38125408089 |
| Main multiarch publication, separate cold cache | 11m 03s | Actions run 38126401171 |
| Tag promotion / release assets | 43s | Actions run 38127140525 |
| Unchanged-tree develop publication, warm cache | 40s | Actions run 38127138061 |
| Pi image pull / verification / initial stop | 349s | v0.1.3 protected receipt |
| Consistent backup and restore test | 29s | same |
| Repeated migrations and data preservation | 11s | same |
| Pi restart and readiness | 88s | same |

The initial approved-release path cost approximately **36 minutes**, excluding
earlier feature development and PR checks. The 40-second warm run was unchanged
application code, not a representative frontend change. No valid pre-optimization
Pi timing exists for an apples-to-apples speedup claim.

## Priorities and preliminary estimates

| Priority / change | Simple frontend fix, dependencies unchanged | New page + backend change + additive DB migration | Why / limits |
| --- | --- | --- | --- |
| 1. Native arm64 + amd64 builds in parallel | Changed publication ~2–5 min instead of emulated cold 11–16 min | ~3–6 min, cold dependencies may add more | Remove emulation, keep both CPU targets and runtime checks |
| 1. Registry cache shared by trusted branches | Main promotion ~0.5–2 min for unchanged build inputs | Same: reuse already-tested develop layers | Removes main's branch-cache cold start; never substitute an incorrect revision |
| 2. Build once for container validation | Remove 2 redundant frontend/backend builds per PR | Same redundant builds removed | Keep build, API/MCP health, migration, and browser gates |
| 2. Remove duplicate post-merge test runs safely | Save ~3–4 min where they become the critical path | Same, but migrations must remain covered | Requires strict PR protections and a documented coverage map; not applied merely to make CI green |
| 3. Prefetch without stopping the UI | Transfer overlaps acceptance; target stopped-service time ~1–2 min | Still preserve consistent backup, actual migration time additional | Memory/storage contention may make online pulling slower; measure on Pi |
| 3. Avoid repeated startup migrations / redundant service restarts | Potential ~10–60s per deploy | Smaller saving when backend really must restart | Only skip demonstrably unchanged work; never infer schema compatibility from filenames alone |

**Provisional machine-time target, not yet verified:** simple fix ~6–12 minutes
from ready-for-review PR to healthy Pi; cross-cutting change ~8–15 minutes plus any
data-dependent migration cost. Estimates overlap; do not sum every row's saving.
Queue delays and required human acceptance remain outside these ranges.

## Safety and completion requirements

- Preserve the existing required status-check names until an explicit, tested
  replacement is ready. No disabling branch protection or security scanning.
- Native images must have the expected CPU/OS and full source revision, and pass
  their runtime checks before a multiarch index is published.
- PR code cannot write trusted build caches or production release tags.
- Main/develop cache sharing is layer reuse, not falsely relabelling an older
  binary as a newly tested commit. Immutable release tags still pin exact digests.
- Benchmark a simple code change and a new-page/backend/migration change using
  disposable fixtures and an isolated database. No synthetic feature or migration
  is to be deployed into the owner's production database.
- Record clean and warm timings, transferred layers, downtime, backup/restore,
  migration, readiness, and data-preservation results. Distinguish measured values
  from estimates and report any benchmark coverage gaps.
- Re-profile remaining critical-path work before calling it hardware-bound. CI
  duplication, avoidable rebuilds, repeated migrations or avoidable downtime are
  not hardware limits. Required tests, approval and data-integrity work cannot be
  removed just to improve the stopwatch result.

## References

- [GitHub-hosted runner CPU types and public-repository availability](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Docker multi-platform build distribution](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [Registry-backed build cache](https://docs.docker.com/build/cache/backends/registry/)

## Current status

Native publishing passed its first live benchmark at commit
`0f251b1de46fbaf7562edd58d7965abe3ec31670`:
[Actions run 38129619888](https://github.com/charlie-turner-314/personal-portfolio/actions/runs/38129619888).
Created 09:47:22 UTC and completed 09:50:58 UTC on 2026-10-11: **3m 36s**
including scheduling, four builds, native runtime checks and index assembly.

| Native build | Build/publish step | Whole native job |
| --- | ---: | ---: |
| Frontend arm64 | 1m 51s | 2m 18s |
| Backend arm64 | 1m 59s | 2m 35s |
| Frontend amd64 | 2m 15s | 2m 48s |
| Backend amd64 | 2m 24s | 3m 07s |

Compared with the prior cold publications (16m 10s and 11m 03s), this run
was approximately 78% and 67% shorter, respectively. These are observed runs,
not controlled identical-input comparisons or end-to-end deployment speedups.
All four native runtime checks and both multiarch revision validations passed;
the initial PR CI, Docker validation, Compose E2E and CodeQL runs also passed.
This benchmark did not deploy to the Pi or change production data.

PR Docker validation now imports the trusted registry cache read-only, with the
old GHA cache retained as a fallback. It cannot export to the trusted cache.
The cache benefit needs measurement after trusted branch publication seeds it.

Scenario benchmarks, warm changed-source timings, duplicate-build consolidation
and incremental Pi transfer/downtime measurements remain outstanding. The
end-to-end estimates above are **not validated**. Do not describe the goal as
completed or the Pi as the sole remaining bottleneck yet.
