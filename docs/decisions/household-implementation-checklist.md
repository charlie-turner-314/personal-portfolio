# Household implementation progress

- [x] Read objective and delivery governance; preserve dirty primary checkout.
- [x] Isolated worktree from develop 36ccf6e263f115f5e064de22f6099a4fe68b02d7.
- [x] Inspect initial access, category, ownership and lifecycle consumers.
- [x] Decision record before schema changes.
- [ ] Complete consumer inventory and implement canonical safe vocabulary.
  Initial central definition predicate and sanitized projection implemented in both runtimes; transaction/budget/planned/forecast/subscription selection now uses it. Remaining: persistent vocabulary lifecycle, management, AI consumers and migration.
  Exact category-ID grouping/filtering replaces automatic name equivalence.
- [ ] Central permissions for category application, metadata and management.
- [ ] Transactional data mapping, dry run, idempotency, failure and recovery tests.
- [ ] Explicit account and membership transition previews, stale-plan checks, audit.
- [ ] Household creation, join, share, withdraw, leave/remove, move, dissolution UI.
- [ ] Effective-dated ownership for assets/liabilities and all reporting surfaces.
- [ ] Explicit reporting scopes/coverage, boundary transfers, balance/FX gaps.
- [ ] Replace misleading saving/funding surfaces and superseded logic.
  Saving summary heading and Sankey balancing labels corrected; boundary attribution still needs full audit.
- [ ] Acceptance matrix, regression fixtures, API/export/cache/job revocation.
- [ ] Protected release-lab upgrade/recovery rehearsals.
- [ ] Critical browser journeys; appropriate build/test gates.
- [ ] Reviewable develop PR with evidence, tradeoffs and UAT instructions.

## Current verification (intermediate, not delivery evidence)

- TypeScript no-emit check passed after initial category access changes.
- 51 frontend tests passed in nine files, including real PostgreSQL temporary-table tests for definition access, household exit, outsider isolation and exact-ID filters.
- Protected source identity: Compose project syllogic-develop-uat, database volume syllogic-develop-uat_postgres_data, app upload volume syllogic-develop-uat_uploads_data. Runtime revision is unverified.
- release-lab prepare succeeded in this worktree, port 8128. No candidate application build or upgrade has run yet. Its backup/configuration remains in ignored .release-lab/.
- Synthetic-only Postgres container syllogic-household-model-test was created for tests; no host port is published.
- Primary checkout's unrelated changes remain untouched.
