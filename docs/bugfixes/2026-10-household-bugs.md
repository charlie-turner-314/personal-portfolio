# Household bug fixes, October 2026

User approved main promotion and bypassing disabled GitHub Actions for PPF-57–60.
Each fix follows feature PR → develop → local revision verification → main promotion.
Final release must be deployed to the Pi and checked through normal HTTPS.

## PPF-59: member dashboard ownership

Starting develop: `8ea36ce`.

Reproduction: a failing dashboard query regression proved the default member scope
omitted ownership SQL and the linked household identity. A synthetic PostgreSQL
fixture reproduces the reported 26 September–25 October totals without live data:
whole-account Funding Gap 5,244.92, default member Funding Gap 1,974.02 after the
fix, income 5,158.11, spending 4,337.23 and investment outflows 2,794.90 unchanged.
Private accounts and internal transfers are excluded by the actual action SQL.

Plan and implementation: default cash flow, cash balance and cash history to the
login's self identity plus its linked household person; resolve allocation sets
at the transaction date and retain legacy equal shares. Keep explicit person
selection and an explicit Whole accounts scope. Linked group members use account
permission checks, consistent with the primary transaction, so a shared owner's
transaction is not silently discarded merely because another member views it.
Named household-person selection also resolves that person's linked login self
identity, retaining personal salary alongside their share of joint activity.
The PostgreSQL fixture verifies named selection equals default member selection.
Dashboard filter navigation now displays Updating dashboard… while the server
transition is pending. Net-worth asset detail retains its separately labelled visible-finances scope.

Local verification so far: six focused test files, 22 tests passed, including actual
PostgreSQL execution; TypeScript and changed-file ESLint passed. The new query test
was observed failing before implementation. Source build at `9c21885` and both migration runs passed; six-table preservation
matched 2 users, 2 auth accounts, 2 accounts and 29 transactions (holdings and broker
trades empty). Populated and fresh account smoke passed. Chromium confirmed salary
in named member scope and immediate update feedback with a deliberately delayed
request. The lab uses localhost:8108; its initial port conflict was corrected only
in its encrypted configuration. Feature/develop merges, main promotion and Pi
deployment remain to be recorded.

PPF-59 delivery: feature PR #87 merged to develop `93f677c`; 40 tests passed on
that checkout, source build/migrations passed and preserved 14 users/auth accounts,
17 accounts, 3,277 transactions, 8 holdings and 8 broker trades. Authenticated smoke
and the Chromium named-member regression passed again. Promotion PR #88 merged to
main `af97a27`; ancestry synchronized through PR #89 (`832e7e0` develop). Required
branch checks were restored and verified after each authorized Actions bypass.
The Pi remains on v0.1.14 pending the final four-fix release.

## PPF-60: equivalent household categories

Starting develop: `832e7e0`. The regression fixture proved two expense Housing IDs
produced separate categories/Sankey nodes; a same-name income category must remain
distinct. The new test failed before implementation.

Plan: group reporting by trimmed, case-insensitive name and type without merging
stored categories. Retain a stable real ID for navigation and expand matching IDs
in SQL beneath account permissions. Fetch reporting filter metadata live from own
categories and permitted transactions; keep editing options separate. Normalize
selected IDs to one filter choice/tag. Apply the same summary and filtering rules
to the spending-category drilldown reached from dashboard category bars.

At feature runtime `77b3ead`, the source build, two migration runs, health and
populated/fresh smoke checks passed. Existing values matched 16 users/auth accounts,
19 accounts, 3,279 transactions, 8 holdings and 8 broker trades. The browser proved
one Housing Sankey node, both permitted underlying transaction IDs in its drilldown,
private-account exclusion and one reporting filter option. The first browser
attempt needed its locator scoped to the filter popover; no runtime fix was needed.
All 98 frontend test files passed (463 tests; one skipped), including PostgreSQL
filter execution. TypeScript and changed-file ESLint passed.
Feature merge, exact develop verification, main promotion and Pi delivery remain.

PPF-60 delivery: feature PR #90 merged as develop `8d8749e`. Its source build,
migration reruns and preservation checks passed (22 users/auth accounts, 27
accounts, 3,289 transactions, 8 holdings, 8 broker trades). Fifty-seven focused
tests, authenticated smoke and both browser regressions passed on the merged
revision. Promotion PR #91 merged main `71de04e`; PR #92 synchronized ancestry to
develop `5a40563`. Required checks were restored and verified after each bypass.

## PPF-58: explicit property sharing

Starting develop: `5a40563`. New list/detail query regression failed because both
queries used login ownership alone and had no grant predicate.

Plan: separate property grants from economic ownership and mortgage-account
permission. Owner-controlled property sharing enables shared detail and valuation
edits, with owner-only ownership/link/sharing/deletion controls. List, detail,
valuations, tagged activity, rental reports, transaction tagging, search, ownership
badges, net worth and MCP must use the same access boundary. Mortgage and tagged
transaction detail additionally require account permission. Revocation/leave must
remove grants and never revive them on rejoin. Never transfer or duplicate property
rows. Serialize shared edits with grant revocation. Keep original property and
valuation user IDs. UI and backend implementation/tests are in progress. The broader backend privacy
harness exposed a pre-existing create_transaction assignment to the collaborator
instead of the canonical account owner (unchanged by the property feature). The
existing canonical-ownership assertion failed; the route now assigns account.user_id.
This preserves shared property-account activity and joint-account history.
The browser also proved the existing property detail page crashed by calling
buttonVariants from a client module in server rendering. The shared style helper
now lives in a server-compatible module, with the client Button importing it.

PPF-58 feature verification: source runtime `fa4d454` built successfully, migrated
twice, and preserved 31 users/auth accounts, 38 accounts, 3,299 transactions,
8 holdings and 8 broker trades. The full owner/member Chromium journey passed:
private defaults, explicit sharing, separate mortgage consent, owner/member edit
boundaries, valuation and ownership/link preservation, permitted rental activity,
net-worth attribution (377,000 → 117,000 → 142,000 fixture totals), live unsharing,
leave/rejoin and no revived grants. The backend privacy harness and 135 regression
tests passed; the extended frontend harness also proves private property economic
attribution survives leaving. Final develop verification and promotion remain.

PPF-58 delivery: feature PR #93 merged as develop `1fababc`. Exact merged source
build/migrations preserved 33 users/auth accounts, 41 accounts, 3,301 transactions,
8 holdings and 8 broker trades. Twenty-four focused tests, authenticated smoke
and the complete property browser journey passed again. Promotion PR #94 merged
main `e50ecfb`; PR #95 synchronized develop to `0686a22`.

## PPF-57: canonical Up accounts and private sources

Starting develop: `0686a22`. A new regression invoked the worker with a retained
archived mapping and failed: sync_transactions was still called for that account.
This confirms archiving alone was insufficient. The original issue also records
three joint provider identities duplicated across separate private connections.

Plan: explicit connection-to-canonical-account bindings, each owned by its token's
login; source-specific checkpoints, live account permission checks and serialized
canonical writes. Preserve explicit Skip. New shared-account mapping must bind to
the existing account rather than create another balance. Existing pre-household
imports need a reviewed, atomic exact-provider-ID consolidation with original
history archives, preserved manual edits/graphs/ownership/anchors and rollback
on conflicting relationships. No migration-time merge or implicit sharing. Revoke
cross-login source bindings on unshare/leave while preserving personal sources.

Implementation is in progress. The archived-account test now passes with 136
backend regressions. Source sync uses canonical resource ownership and checks
consent after external fetching, in bounded write batches; it retains manual
edits and does not delete amount/date-only CSV matches. Account locks precede
consent locks to avoid deadlocks. Retired account references are blocked at the
DB boundary so in-flight writes cannot silently append to a hidden duplicate.

## Remaining issues

- PPF-57: prevent/reconcile joint Up duplicate account mappings without losing
  transactions, edits, relationships, ownership or anchored balances. Prior Pi
  data repair is not an application fix.
- PPF-58: explicit property and mortgage sharing, with list/detail/edit/report
  consistency, privacy and revocation. Economic ownership alone grants no access.
- PPF-60: group equivalent household categories by name/type for display and
  carry all underlying permitted category IDs through filters and drilldowns.

PPF-57 validation: frontend 100 files/466 tests passed (one skipped), plus two new
review/progress UI tests. TypeScript passes; changed-file lint has no errors.
The disposable PostgreSQL suite applies migration 0052 twice and verifies original
ownership/dates, daily balances, mortgage and transaction links, manual-conflict
review, exact-provider union/deduplication, private archive isolation, independent
credentials, repeated imports, retired-record write rejection, idempotency and
mid-fetch revocation. Backend regression suite: 136 passed. Source runtime
37023a4 built successfully, migrations ran twice and preservation checks passed.
Chromium exercises the real settings/server-action/backend consolidation flow;
all assertions passed. Authenticated demo dashboard/transactions/investments and
fresh-account onboarding smoke passed. Manual sync now explicitly bypasses the
recent-sync cooldown while retaining the in-progress guard, so newly connected
shared sources can be used immediately.
