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

## Remaining issues

- PPF-57: prevent/reconcile joint Up duplicate account mappings without losing
  transactions, edits, relationships, ownership or anchored balances. Prior Pi
  data repair is not an application fix.
- PPF-58: explicit property and mortgage sharing, with list/detail/edit/report
  consistency, privacy and revocation. Economic ownership alone grants no access.
- PPF-60: group equivalent household categories by name/type for display and
  carry all underlying permitted category IDs through filters and drilldowns.
