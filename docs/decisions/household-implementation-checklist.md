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

## Vocabulary and lifecycle checkpoint

- Added stable-ID category vocabulary entries; current membership selects one set. Definitions imported on join are retained on both sides before exit/dissolution. No name-based merge, financial rewrite, credential transfer or account grant is performed by migration.
- Join/share/withdraw/leave/remove/dissolve now have server previews, actor-bound HMAC confirmation, live state recheck under the existing household lock, atomic mutation/audit, and matching review UI. Property and aggregate access effects are included without private totals.
- Added read-only lab inventory script: protected restore has 42 definitions, 21 duplicate labels retained and 11 category-reference columns. Detailed mappings stay in ignored mode-600 lab state.
- Added synthetic lifecycle tests for stale consent, injected failure, post-write recovery, repeated migration, entry/exit/move/dissolution and preserved ownership. They pass; full browser and delivery review remain outstanding.
- AI category lookup now preserves ambiguous definitions and strips partner guidance. Suggestion reads/reviews check current account access, including after inference. Category removal retires definitions instead of deleting historical/planning references; onboarding preserves existing references too.
- Backend focused category/context/suggestion/MCP suite: 64 tests passed using candidate app/tasks mounted in a cached runtime with test dependencies added only to the ephemeral container. This is not a candidate image build.
- Known remaining major work: effective-dated property/vehicle attribution; complete scope/coverage and boundary-transfer audit; queued jobs/exports/cache matrix; UI/browser validation; full candidate build; exact-revision rehearsal and recovery receipt; reviewable PR/UAT delivery. Goal remains active.

## Ownership checkpoint (2026-10-26)

- Dated complete sets added for properties and vehicles, with legacy-row preservation and exact equal-share totals. Generic owner API/UI writes dated sets for all three resource kinds and records provenance.
- A single TypeScript resolver and corresponding Python resolver handle effective sets and stable login/person aliases across household changes. Both keep access separate.
- Asset overview now defaults to My view economic shares; explicit Household view passes its scope through without falling back to My view. Scope labels are explicit. Broader transaction/budget/report coverage audit remains outstanding.
- Retirement is now vocabulary-scoped; types/default financial purposes are fixed after creation. Retained foreign definitions stay selectable without foreign private guidance.
- Latest focused validation: 71 frontend tests in 14 files; 95 backend tests; TypeScript no-emit check passed. Backend used current app/tasks mounted into a cached runtime with ephemeral pytest/pypdf dependencies. Four existing deprecation/SQLAlchemy warnings remain.
- Asset migration passed twice on synthetic fixtures and the protected restored source, with six core-table hashes unchanged. These are intermediate dirty-source rehearsals, not the final recorded-revision evidence. Do not reuse them as candidate image acceptance.

### Next audit priorities

1. Currency conversion: dashboard activity currently trusts source-user functional_amount as actor currency. Fix with actor/date-aware conversion, test shared cross-currency/missing rates. Net-worth calculation currently sums differently denominated property/vehicle values and coerces missing values to zero; fix coverage/unavailability.
2. Transfer/report boundaries: audit internal_transfer_id exclusions, invisible or filtered/date-straddling peers, and distinction between boundary movement and proven ownership redistribution. Existing 70,000 contribution fixtures exist in dashboard.ownership.integration.test.ts, dashboard/activity.test.ts and e2e/cash-flow-contributions.spec.ts; expand ratios and privacy coverage. Avoid claiming traced funding.
3. Superseded Python analytics routes group categories by name, join manual/AI IDs with OR (duplicate rows), and classify sign-only income/spending. Replace with coherent scope/purpose logic or simplify the misleading surface. Audit report_data_service and MCP analytics too.
4. Transactions/budgets/category reports must use consistent My/Household scopes and visible account coverage, dated attribution per record, no inference of inaccessible zero balances.
5. Permission revocation matrix: direct API/export/search/queued jobs/caches/attachments/private transfer metadata; run existing scripts/test-household-privacy.py after a candidate app build. It expects an isolated app/backend lab; currently this worktree lab has only DB/Redis from migration-only rehearsal.
6. Complete acceptance matrix; full source image build with release-lab up; exact committed-revision upgrades twice; protected backup/recovery evidence including post-write forward repair; browser critical journeys and UAT instructions; reviewable develop PR with checks. Never promote/deploy main/Pi under this authorization.

### Runtime and command notes

- Worktree: /Users/charlieturner/Documents/Codex/2026-10-26/work-in-goal-mode-implement-and/work/syllogic
- Frontend node_modules is an ignored symlink to the primary checkout’s installed dependencies. Run tsc/vitest with cwd frontend; paths for file mutations should use repository root (earlier cwd mistakes were corrected).
- Synthetic test Postgres: syllogic-household-model-test; host 127.0.0.1:55483; DB household_model_test; local synthetic trust auth, no real data. Tests require HOUSEHOLD_TEST_ISOLATED=yes and HOUSEHOLD_MODEL_TEST_DATABASE_URL=postgresql://postgres@localhost:55483/household_model_test. Pure SQL fixture tests use OWNERSHIP_TEST_POSTGRES_CONTAINER=syllogic-household-model-test and the separate postgres DB, temporary tables only.
- Protected release-lab project syllogic-release-lab-9ea1348b04, port8128 configured. Source containers syllogic-app/syllogic-postgres, existing volume syllogic-develop-uat_postgres_data. All backup/auth keys and detailed mapping reports stay ignored under .release-lab/. Never print decrypted config or credentials. Keep source containers available for state decryption.
- Backend focused tests run in an ephemeral syllogic-backend:local image with --network container:syllogic-household-model-test, candidate backend/app, backend/tasks and backend/tests mounted read-only at /app/app, /app/tasks, /app/tests. Install pytest, pytest-asyncio,pypdf only under /tmp/household-test-deps. Cached backend lacks pypdf; mounting only app but not tasks yields a misleading old-worker failure. Logs are in private .release-lab/backend-model-tests.log.
