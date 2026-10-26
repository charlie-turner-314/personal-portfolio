# Investment capability and data contracts

Implementation base: develop `1bcbf53319d02c84a7fdd81e64afe7aad435f464`.
This branch addresses the Australian capability audit dated 26 October 2026.

## Supported paths

| Path | Recorded capability | Coverage and recovery |
| --- | --- | --- |
| Manual | Equity, ETF, unlisted managed fund, crypto and cash positions; native account/holding currency; optional opening average cost; dated private unit price/NAV with source | Opening snapshots are not a complete acquisition ledger. Market lookup requires verified quote currency. A dated unit price can be supplied for unsupported instruments. Archiving hides a position; it does not record a sale. |
| Generic CSV/XLSX | Preview, mapping, canonical buys/sells, income, DRP, transfers, fees, crypto swaps/rewards, duplicate handling and batch reversal | Unsupported activities remain errors; partial imports remain visible as report coverage warnings. Choose **Unlisted managed fund** for that instrument. The existing `fund` canonical value retains its historical listed-fund/ETF meaning. |
| Superhero | Transaction CSV, Australian/US income CSV, AMIT annual statement PDF | AMIT reconciliation enriches recorded income instead of creating duplicate cash. Populated US rows require an unambiguous symbol. Other brokers use explicit generic mappings; a Superhero fixture does not certify their exports. |
| IBKR Flex | Positions, cash, dated statement mark prices, available typed trades/commissions and recorded CGT allocations | Coverage depends on the configured Flex queries and available broker history. This is not a complete corporate-action or tax-event feed. Missing fee inputs and position/history mismatches remain partial. Disconnecting retains source records and positions. Sold positions retain their history with zero units. |
| CoinSpot V2 | Read-only balances, completed supported activity and transfer observations | Tests exercise pagination, duplicate overlap, failures and reconciliation. API windows are explicitly requested; saturated history limits fail visibly. No guarantee of account-lifetime coverage is inferred from the chosen start date. |
| Binance | Spot fills for configured/discovered symbols, Convert, transfers and supported Earn records | Inactive/unknown pairs and unavailable products need review. Supply missing historic symbols or import their statements. Margin/futures and other unsupported products are not silently classified as Spot activity. |
| Crypto.com Exchange | Spot balances/fills, transfers and supported rewards | Separate from the consumer App. Older trade history needs provider support/statements; connector warnings retain that gap. Unsupported products remain excluded and disclosed. |
| Crypto.com App CSV | Supported Token Wallet export activities | Separate adapter from Exchange and Onchain. Ambiguous tax-character rows remain for review. |

These capabilities have deterministic fixture tests. They do not certify that a particular live account has complete history or valid credentials.

Provider contract checks on 26 October 2026:

- CoinSpot documents distinct read-only endpoints and a maximum of 500 records for completed order-history requests. [CoinSpot V2 API](https://www.coinspot.com.au/v2/api).
- Binance requires a symbol for Spot account trades, limits a page to 1,000, and limits a request combining both time bounds to 24 hours. The adapter starts with `symbol + startTime`, then advances `fromId` without combining incompatible bounds. [Binance Spot account API](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account).
- Crypto.com documents six-month transaction-history retention and directs users to support for older records. Spot trade fetching respects that window and reports the omitted range. Product-specific wallet/reward coverage remains separately disclosed. [Crypto.com transaction history](https://exchange-developer.crypto.com/exchange/v1/docs/api/rest/transaction-history).

## Valuation and performance

- Failed FX conversion is an unavailable valuation, never an identity conversion.
- A missing price is not zero. A confirmed zero quote remains valid. Partial accounts do not overwrite complete account-balance snapshots with subtotals.
- Valuations retain their reporting currency and quote currency/date/source. Legacy rows with unknown currency are not relabelled from mutable user settings. Refresh current valuations or rebuild history from original source evidence before using unverified historical amounts.
- Price caches distinguish providers. The index keeps its old name for migration replay compatibility, but its key is now `(symbol, date, provider)`. Private manual prices use per-holding keys. Yahoo v2 prices resolve currency and normalize supported minor-unit quotes; old cache values are retained separately.
- Portfolio history seeds opening observations and carries each account forward. It stops at the current date and uses dated FX rather than projecting future balances or substituting current FX for missing history.
- A change in portfolio value includes contributions and withdrawals. It is not investment return. Return and best-investment-day remain unavailable until sufficient flow-adjusted data exists. Missing cost basis is never synthesized from chart changes.
- Recorded open-lot basis converts acquisitions and cost-base adjustments at their respective dates. Manual opening averages remain explicitly identified estimates.

## Ownership, reports and lifecycle

- Person scope is applied after account access. Dated complete allocation sets take precedence over legacy shares; linked login and household identities resolve together. Whole-account units and source journal entries are labelled separately from attributed current values/history.
- Income retains all native currency groups. FY and trailing-12-month periods are computed separately; available historical years load their own data.
- A sale consuming multiple lots is one disposal with multiple allocations. The recorded allocation result is an informational sum, not a final net capital gain. Loss ordering, elections and personal tax circumstances are not calculated.
- Unresolved income reconciliation, unmatched crypto transfers, missing AUD values, partial batches, provider coverage gaps and opening-only positions produce explicit coverage warnings. Arithmetic completeness does not certify complete taxpayer history.
- Corporate actions other than supported recorded AMIT adjustments remain unsupported. Splits, consolidations, mergers, fund switches and other unclassified actions must not be substituted with invented buys/sells. Keep them in review and obtain the source records before adding a dedicated adapter/workflow.
- Account creation has a user-scoped idempotency key. Multi-row entry validates all started rows, retains the created account across partial failures, and retries only failed rows. Repeated identical holding requests recover a committed position after a lost response.
- Position edits queue revaluation and flag pending values. Hard deletion is blocked when financial history exists; archiving retains valuations, income, adjustments and journal records.
- Manual and scheduled refreshes persist queued/running/completed/partial/failed state. The UI waits for terminal state or reports a visible timeout. Failed report reads are distinguishable from no records.

## Verification and delivery

Use PostgreSQL for constraints, provider-key collisions, source immutability, decimal values and migration replay. The focused regression suite is `backend/tests/test_investment_reliability.py`; frontend regressions include manual partial-save retry and mixed-currency income. Existing provider, import, reconciliation, crypto accounting and history tests remain relevant.

The release-lab preservation baseline now includes valuations, account balances, price snapshots, income, canonical/source records, runs, adjustments, enrichment, CGT allocations and crypto transfer/lot records, in addition to the original core tables. Run the source build and migrations twice, then perform Australian browser journeys before proposing main promotion. A branch implementation does not authorize main promotion or deployment.
