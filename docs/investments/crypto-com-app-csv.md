# Crypto.com App CSV import

The Crypto.com App preset accepts the original **Token Wallet** CSV. It is not
the parser for Crypto.com Exchange, Onchain, or card-only exports, which have
different schemas and accounting context.

## Export

In the Crypto.com App:

1. Open **Accounts** and select the **History** icon.
2. Select **Export**.
3. Choose **Token Wallet**, set an inclusive date range, and export to CSV.
4. Download the completed report from Export History and upload the original
   CSV without editing its headers.

Crypto.com's current help page says one App report can cover up to three years,
Export History keeps the latest 30 reports, and a generated download remains
available for 30 days. For Australian CGT, export enough history to include the
original acquisitions for every asset disposed of in the target financial year.

Official instructions: <https://help.crypto.com/en/articles/3438579-how-do-i-export-my-transaction-history-app>

## Supported normalization

- Fiat/crypto purchases and sales become canonical buys or sells.
- Crypto exchanges and supported paired wallet conversions become linked swap
  disposal/acquisition events.
- Crypto Earn interest, staking rewards, campaign/referral rewards, and
  identifiable airdrops become ordinary-income acquisitions with provider AUD
  value provenance when `Native Currency` is `AUD`.
- Deposits and withdrawals become transfer candidates. They are non-taxable
  only after a unique opposite movement is found in another owned account.
- Identifiable crypto payments and card top-ups become disposals.
- Explicit negative crypto fee rows become auditable fee disposals.
- Identifiable fiat deposits and withdrawals from the Cash Account export are
  retained as funding audit activities. They do not change crypto holdings or
  CGT; the Token Wallet trade row remains the economic crypto record.

The App file does not provide a dedicated network-fee column. Transfer amounts
are therefore treated as the reported net movement; add any separately known
network fee as its own canonical fee row.

## Review and unsupported rows

The preset deliberately rejects rather than guesses:

- card cashback, reimbursements, and their reversals, whose Australian tax
  character depends on the arrangement;
- Earn/staking lock and unlock bookkeeping where beneficial ownership may not
  have changed;
- untyped Cash Account/card spending rows that are not identifiable funding;
- unpaired conversion legs; and
- new or unknown `Transaction Kind` values.

Rejected rows remain visible in dry-run preview with their source row number and
reason. Classify them manually only after checking the underlying transaction.
Crypto.com Exchange and Onchain data require separate adapters.
