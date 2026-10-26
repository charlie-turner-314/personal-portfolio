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

## Currency checkpoint

- Draft PR opened and attached: https://github.com/charlie-turner-314/personal-portfolio/pull/108 (develop target; not merge-ready). GitHub connector create failed with integration 403, so authenticated gh CLI was used. Branch is pushed through ownership checkpoint 3a24f6d; subsequent currency changes need a push after commit.
- Added actor/date-aware SQL currency conversion. Native amount wins when already in viewer currency; source functional_amount is converted from the custodian’s currency. Missing, zero and future-only rates remain unknown. Cash snapshots use their native/functional denominations correctly.
- Current cash totals and historical series no longer fill missing included balances with zero. Exact cash reconciliation keeps missing snapshots/rates unavailable. Net-worth totals are nullable with explicit missing values/known-only breakdown; different currency amounts are not added without conversion. Active permitted account coverage is displayed.
- Focused currency/cash/net-worth tests: 34 passed across eight files, including real PostgreSQL execution and missing valuation/mixed currency tests. TypeScript check passed. This is additional focused validation, not a full suite or candidate image acceptance.

### Scope/reporting findings to implement next

- Transactions query-state currently has no My/Household view. Keep original bank amount for editing/cash portions; add economic share and a separate attributed display amount rather than overwriting the raw record. Totals currently add native amounts across currencies and should use actor currency with unknown conversion handling. See transactions.ts getTransactionsPage, mapTransactionRowsForUi and components/transactions/columns.tsx.
- Budget defaults to whole accounts while dashboard defaults to My view. Budget person selector currently says Whole household and claims plans are household-wide, although plans are personal. Fix both labels and default scope. Centralize actuals instead of preserving old sign-only queries.
- frontend/lib/spending/category-actuals.ts has a superseded linked SQL path: t2.user_id actor filter, scalar per-person allocation lookup, native amounts and sign-only expenses. It misses capital portions and shared peer semantics. Reuse the central dashboard activity query/summary for budget/category actuals and insights. Category-spending top chart already calls getSpendingByCategory but its detail rows/filters need scope alignment.
- Dashboard getActivitySummary still nets linked peers without selected-account/date constraints; can swallow secondary rows with inaccessible/out-of-period primaries. Fix boundary relative to the selected permitted record set. internal_transfer_id rows are excluded entirely, so separate boundary movements need audit.
- Distinguish boundary transfers (only one permitted/in-period leg) from ownership redistribution proven with the complete selected leg set. Do not use private peer metadata or private totals to make this distinction. Existing transfer summary labels claim ownership transfers too broadly.
- Sankey balancing labels currently say Income above consumption / Consumption above income even though activitySankey includes capital and transfers; these are not necessarily saving. Simplify/replace that surface or use precise included-flow difference labels with no funding provenance claim.
- Python analytics endpoints still need replacement of sign-only income/spending, manual/AI OR joins and name-based grouping; report_data_service and MCP need the same purpose/scope audit.

## Shared activity/budget boundary checkpoint

- Extracted the dashboard activity SQL into `lib/reporting/activity-query.ts`. One materialized permitted record set applies actor access, selected dates/accounts, dated economic shares and reporting currency. Linked peers can only come from that set; an unavailable primary cannot swallow a visible secondary.
- Automatic transfer source/mirror records remain financial facts even when an old detector excluded them from ordinary analytics. Balanced visible full-value legs establish redistribution by dated ownership; missing/private/filtered/out-of-period counterparts remain boundary movements. No hidden peer totals or existence checks are used to label a movement.
- Budget category actuals and contributor explanations now consume that activity calculation. Personal plans remain personal in both My/Household views. Consumption and capital are separately visible, refunds/withdrawals retain direction, unclassified movements remain in totals, and missing conversion yields unavailable amounts. Partner recurring-rule metadata is not exposed or inferred.
- Replaced the Sankey balancing labels with Calculated net inflow/outflow and described them as an arithmetic movement difference, independent of recorded cash balances. Ribbons remain explicitly proportional, never traced funding.
- Validation: 58 tests passed across seven files, including 14 PostgreSQL integration cases. Tested alternate amounts/ratios, selected accounts, date straddles, missing/private primaries, immediate grant revocation, generated mirror description redaction, mixed principal/interest and unknown FX. TypeScript no-emit passed. Reusing the permitted CTE reduced the integration suite from ~66s to ~4s; earlier failures were test-timeouts from the repeated correlated query, now resolved.
- Remaining scope/coverage, transaction display, Python analytics/jobs/privacy audit, browser/build/release-lab and final delivery gates remain open. This checkpoint is focused source validation, not candidate-image or final migration evidence.

## Transaction, category and export scope checkpoint

- Transactions now carry original bank amount/currency separately from dated economic share and attributed reporting-currency amount. My/Household selection persists through pagination, filters, chart drilldowns and global navigation filters. Amount sorting/ranges use the selected reporting amount. Unknown conversion stays visible under an amount range and makes aggregate movement totals unavailable.
- Shared transaction rows still remain editable as bank facts; their display shows both attributed and original amounts. Details label the original bank amount. Movement-in/out totals are not presented as income/consumption.
- CSV export refreshes all requested records against live server account permissions; a missing/revoked selected record rejects the export. CSV preserves original values and includes attributed amount, reporting currency, economic share, stable category ID and explicit portions. A previously downloaded copy remains outside revocation.
- Generated legacy mirror source-account names are suppressed in frontend reads, search/sort and export. Private recurring rules cannot be used as a frontend filter oracle. Backend mirror creation, routes, MCP/search and worker contexts still need the full corresponding audit.
- Removed the category-spending duplicate transaction mapper/query. Category totals and detail pagination now use the same consumption entries (including refunds, linked netting and mixed portions), then re-fetch safe details under live permissions. Previous-period comparisons use category IDs, not names. Missing FX is labelled as known-only coverage. View scope is preserved in category selection and chart links.
- Validation: combined transaction-related run passed 61 tests in16files, navigation run passed12tests in3files, final real migrated PostgreSQL scope suite passed7tests. TypeScript no-emit passed. Focused lint passed without warnings. These focused runs overlap; do not add their counts as independent acceptance cases.
- Next: selected-account coverage and unavailable-filter behavior across all reports (including historical inactive accounts); backend analytics/report/newsletter/MCP coherent model; old mirror metadata at every backend boundary; full revocation/cache/job matrix; candidate image and exact-revision lab/recovery/browser gates. PR remains draft and goal active.

## Coverage checkpoint

- A central reporting coverage query returns only currently permitted account names and includes closed accounts owned by the custodian for historical activity. Closed shared accounts remain unavailable after their live grant stops applying. Current cash/net-worth balances still explicitly use active accounts.
- Explicit inaccessible, withdrawn or nonexistent account selections fail with the same unavailable-selection response instead of silently dropping those IDs and reporting zero. Activity, budget actuals, transaction pages, current balances, balance histories, cash reconciliation and asset overviews enforce the selection. The final resource query still rechecks account access.
- Dashboard, budget, transactions and category pages show a clear-account-filter recovery link before calculating an unavailable selection. Date/view/category context is preserved. Dashboard/budget coverage lists name the permitted included accounts; transaction coverage already lists them. Manual entry continues to offer active accounts.
- Focused verification: 50 tests passed in7files, including real PostgreSQL activity/cash reconciliation and full migrated schema scope tests. Added custodian closed-history coverage, private/stale selection rejection, revoked selected-account rejection and a rendered recoverable-selection UI test. TypeScript no-emit passed. Focused lint has no errors; one pre-existing explicit-any warning in cached.ts remains.
- A former reconciliation fixture silently ignored a selected private account. Its expected behavior now rejects that selection; the equivalent permitted selection retains its independently recorded400 cash change.
- Remaining: backend analytics/MCP/newsletter model consistency and backend mirror metadata; complete privacy/revocation/job/cache matrix; candidate image, final exact-revision migration/recovery receipts, browser acceptance and final PR/UAT delivery. No final release evidence claimed.
