# Australian investment reliability verification

Date: 26 October 2026. Branch: `codex/investment-reliability`.
Recorded develop base: `1bcbf53319d02c84a7fdd81e64afe7aad435f464`.
Runtime candidate: `da6dd4fc8cf614385c1324cde439b83a67387aaa` (the final verification-record commit does not change runtime code).

## Audit disposition

| Audit item | Implemented behaviour | Evidence |
| --- | --- | --- |
| INV-01 Australian currencies | Shared currency choices, AUD and profile/account defaults, explicit foreign currencies retained | ManualForm tests; Australian browser journey |
| INV-02 false FX | Missing conversion fails explicitly; no identity or current-date fallback in investment valuation/backfill | Reliability and broker-backfill tests |
| INV-03 missing prices | Unavailable differs from confirmed zero; preserve complete balances, display incomplete coverage | Reliability, valuation and holdings-table tests |
| INV-04 stale mutations | Corrections, archive, deletion, import and reversal queue valuation; changed quantities flag pending values | Reliability/import route tests; browser quantity correction |
| INV-05 history | Seed opening account observations, carry forward separately, retain actual chart dates; strict historical currency conversion | Reliability history tests; dated chart implementation |
| INV-06 fabricated returns | No chart-derived cost basis or profit; investment return unavailable until supportable cash-flow-adjusted data exists | Overview/stats implementation and component tests; browser unavailable-return assertion |
| INV-07 account metadata | Native currency, original source and manual-add capability retained | Reliability account metadata and ManualForm tests |
| INV-08 first import | Create an empty account directly from import; no dummy position | Australian browser journey |
| INV-09 partial save | Validate started rows; account idempotency; retain created account and retry failed positions only | ManualForm and reliability idempotency tests |
| INV-10 ownership | Validated person scope on aggregates/history; dated allocations and linked identities after account access | Dated shares, private account, revocation, alias and browser tests |
| INV-11 income/year | All currency groups, actual trailing interval, selectable historical Australian FY | Reliability and income component tests; AUD/USD/FY browser assertions |
| INV-12 CGT contract | Distinct disposals and allocations; recorded allocation result labelled; coverage includes incomplete inputs/history | Multi-lot disposal regression, CGT export/reconciliation tests |
| INV-13 asset types/NAV | Manual equity, ETF, managed fund, crypto and cash; private dated unit prices | Type validation; private NAV tests; fractional fund and crypto browser valuations |
| INV-14 instrument lookup | Exact identity/currency resolution, explicit lookup failure, minor-unit normalization, cancellable independent requests | Yahoo/reliability and SymbolSearchInput tests; delayed-search browser scenario |
| INV-15 historical basis | Acquisition/adjustment-date FX for recorded open lots; opening averages explicitly estimates; unsupported lots unavailable | Reliability lot FX and incomplete IBKR-history tests |
| INV-16 refresh | Persist queued/running/completed/partial/failed state; wait/timeout feedback; serialize refreshes across commits | Status, advisory-lock and newer-request regressions |
| INV-17 hidden read failures | Overview and detail render explicit unavailable/error states separately from empty records | Section/detail source contracts and component rendering |
| INV-18 destructive deletion | Reject hard deletion with financial dependencies; archive retains records | PostgreSQL deletion/archive regression |

Additional reviewed risks are addressed in `INVESTMENTS.md`: provider-qualified cache identities, private per-holding prices, stored currency provenance, disconnected-source editability, provider coverage limits, and explicit unsupported-action review. IBKR uses dated statement marks, preserves closed positions, records typed commissions and reports incomplete lots/position mismatches. Historical balance changes use recorded native currencies rather than mutable profile preferences. Portfolio holdings reads have a regression showing query count does not grow with twenty additional positions.

## Verification

- PostgreSQL investment/provider/accounting regression suite: **201 passed** across 25 test modules.
- Full frontend Vitest suite: **493 passed, 19 skipped** across 106 passing and 4 skipped files.
- Australian investment Playwright journey: **1 passed** on the runtime candidate above, including an intentionally delayed symbol search while saving a manual fund.
- TypeScript and changed-file ESLint checks passed.
- Release-lab helper suite: **7 passed**.
- Release-lab account preparation and cookie-authenticated smoke passed for both the populated demo and fresh synthetic account, including authenticated investment rendering.
- Production source build and both migration passes succeeded. All **18 preservation comparisons passed**, including populated holdings (12), trades (5), holding valuations (10), account balances, price snapshots (10), income events (9), canonical activities (5), source records (5), and ingestion runs (5).
- Desktop and 390px mobile screenshots inspected; mobile type labels fit without overlap. Test results/traces are private under `.release-lab/`.


The PostgreSQL suite covers canonical import/reversal and provenance, fees, historical FX, AMIT enrichment without duplicate cash, DRP, FIFO allocations/exports, crypto swaps/rewards/fees, owned transfers preserving original lots/dates, reconnect/idempotency/failure handling, valuation and migrations. These are deterministic fixtures, not certification of a live broker account.

The opt-in browser fixture creates only new synthetic users in an explicitly verified local release-lab database. It imports an AUD ETF into a new empty account, saves a fractional managed fund during a delayed market lookup, records its NAV, checks whole-account and attributed values, verifies mixed-currency FY/trailing income, changes quantity, and adds fractional manual crypto with its own sourced price. Mobile assertions cover page width and clipped instrument labels. Synthetic credentials and traces remain in ignored `.release-lab/`.

The source-build lab runs both migrations and verifies hashes/counts before restarting its writers. Its expanded preservation comparison covers eighteen core/investment tables. Populated holdings, trades, valuations, balances, prices, income, canonical activities, source records and ingestion runs were preserved across repeated upgrades. Tables empty in the baseline do not establish populated-table migration coverage; PostgreSQL service/schema tests supply additional coverage.

## Limits and release state

- Legacy valuations without provable currency remain unverified; they are not relabelled from today's settings. Source-backed trade/price backfills require dated FX and complete account observations before replacing balance totals.
- Flow-adjusted investment returns, final personal tax calculations, and unsupported corporate actions are deliberately unavailable or flagged for review, as specified by the containment plan. Opening snapshots do not imply complete acquisition history.
- A general Compose smoke attempt passed no-CSV onboarding, but its two asynchronous bank-import journeys timed out. Both `process_csv_import` jobs remained queued in the lab's isolated Redis: this rehearsal deliberately omits workers/beat to avoid operating restored connections. This is not a claim that the complete Compose browser suite passed.
- Source container identity and volumes were inspected before preparation. No real account was reset. The original checkout's uncommitted dashboard work was not edited.
- This is branch verification. No develop/main merge, Pi deployment, user acceptance or production tax/provider certification is claimed. Pi UAT and promotion remain governed by the repository's acceptance workflow when requested.
