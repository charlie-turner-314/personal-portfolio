# Dashboard performance regression — 2026-10-25

## Reproduction and cause

The Pi runs v0.1.15 / main `4274ba9517468f9c6f1f81f234af8e40b96a4ebd`.
Read-only EXPLAIN ANALYZE of its real net-worth query took 16,447 ms; JIT
compilation alone consumed 16,294 ms across 449 generated functions. The same
query with JIT disabled on that diagnostic connection took 13 ms and returned
identical results. Estimated cost was 3,022,426, above PostgreSQL's 500,000
inlining/optimization thresholds. Exact v0.1.14 query/access helpers against the
same current data took 1,258 ms (1,176 ms JIT), cost 352,788. The expanded property
sharing query caused the threshold crossing. Basic HTTPS login was 140 ms TTFB.

The Pi had 438 MB available RAM out of 1.8 GiB and 1.1 GiB resident swap, but almost
no active swap or I/O wait. No application OOM kills/restarts occurred. PostgreSQL
used one core while application services were mostly idle. SQL compilation and
shared rendering boundaries were the primary bottlenecks.

## Fix

Compute account ownership once in a materialized input projection; materialize
valuation/conversion stages to avoid repeated expression expansion. Execute this
small per-household aggregate in a transaction with `SET LOCAL jit = off`.
This is scoped to one query transaction: pooled sessions and other queries retain
their existing JIT settings. No global database configuration change or TTL cache
is introduced. Grants, live memberships, dated ownership, missing valuation/FX
behavior and projection-only sharing remain intact.

Remove asset/portfolio fetching from the core cash-flow data wait. Liabilities,
assets, personal net worth and investment summary have independent Suspense
boundaries and accessible placeholders. React.cache deduplicates shared asset
and portfolio reads within one render, never across requests/users. Each new
request still checks permissions live.

## Candidate verification

Read-only candidate benchmark on the Pi: query execution 10.7 ms, service calls
28.8–32.0 ms across both real account holders. Candidate and v0.1.15 financial
results were identical for both; pooled connection JIT returned to `on` afterward.
This benchmark executes candidate code in a separate diagnostic process; it does
not change the deployed app. Source build/browser and merged-revision evidence
will be recorded below after completion.
