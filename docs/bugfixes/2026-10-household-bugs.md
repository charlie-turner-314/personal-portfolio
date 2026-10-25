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

## Remaining issues

- PPF-57: prevent/reconcile joint Up duplicate account mappings without losing
  transactions, edits, relationships, ownership or anchored balances. Prior Pi
  data repair is not an application fix.
- PPF-58: explicit property and mortgage sharing, with list/detail/edit/report
  consistency, privacy and revocation. Economic ownership alone grants no access.
- PPF-60: group equivalent household categories by name/type for display and
  carry all underlying permitted category IDs through filters and drilldowns.
