# Saving, allocations and shared contributions

Base revision: develop 1bcbf53319d02c84a7fdd81e64afe7aad435f464.

## Model

Ownership determines the share of activity reported. It does not identify who
funded a later payment. Saving from income is income minus consumption, including
loan interest. Investment and loan-principal allocations remain cash movements,
separate from consumption.

Categories can default to an investment or loan-principal allocation. A
transaction can override that default, or explicitly restore everyday activity.
An optional native-currency allocation portion supports mixed principal/interest:
the remainder stays in the transaction's ordinary category. Allocation fractions
are applied to functional-currency amounts and the transaction-date ownership
share. Positive allocation transactions are returns/withdrawals, not new income.

Transfers aggregate the signed, ownership-weighted visible legs of linked
transfer groups in the selected dates/accounts. Equal ownership transfers cancel;
unequal ownership produces a movement into or out of the reported share.
Permission is checked per visible account, even when the primary is private.
Groups containing a visible expense or explicit allocation are excluded from this
transfer aggregation to avoid double-counting reimbursements or investment legs.
Private counterpart amounts, accounts and identities are never fetched to explain
a shared credit.

For example: a partner transfers 70,000 from a solely owned account into a 50/50
account. Their reported share has a 35,000 transfer out; the other member has a
35,000 transfer in. A later 70,000 principal payment allocates 35,000 to each
member's share. The other member has no cash deficit from that pair, and neither
transfer is earned income. The model works independently for each transaction;
there is no parcel, provenance, gift, or reimbursement inference.

## UI and migration

Dashboard spending/history/saving use consumption. A separate summary and Sankey
show investment allocations, principal and transfers. The Sankey residual is
labelled Cash retained / Cash required, rather than claiming it is saving or
unexplained missing money.

Transaction details expose cash-flow purpose and optional allocation portion;
category settings expose defaults. Unclassified housing remains spending until
reviewed. No payee, amount, person or mortgage match automatically changes it.
The existing Investment Transfer category gets a one-time semantic default during
the additive, idempotent migration; renaming categories does not control runtime
classification.

Amounts, category selections, balances, ownership and transfer links are
preserved. Balance adjustments and synthetic internal-transfer legs cannot be
reclassified through the new action. Purpose writes check live account access in
both the read and update.

Reported cash flow is saving minus allocations plus transfers in minus transfers
out. It is not a bank-balance reconciliation: unmatched transfers, excluded rows,
missing conversions, date/account boundaries and balance adjustments may differ.
Household contributions remain distinct from income. Category-based budgets and
transaction drilldowns retain the actual transaction values.

## Validation

Regression coverage includes unequal contributions, hidden primary transactions,
own and named identities, whole-account views, account/date filters, a payment in
a later window than its contribution, dated 25/75 ownership, FX conversion,
partial principal, returns, missing conversion, and reimbursements.

An isolated source-build release lab applies migrations twice and compares
original core-table row hashes. Chromium seeds only fresh synthetic users and
classifies a repayment through transaction details, checking saving, allocations,
transfers, net reported cash flow, and preservation of amount/category.

The original working directory's existing asset-reporting edits are untouched.
No Pi deployment or live transaction recategorization is part of implementation.

Verification completed on the source-build lab: 484 frontend tests passed;
five PostgreSQL integration cases passed; Chromium contribution editing and
existing named-member salary/filter journeys passed. TypeScript and targeted
ESLint checks passed (the existing category editor effect/entity warnings remain).
Both migration runs preserved existing core-table hashes. Visual inspection
shortened the Sankey transfer labels so they fit within the chart margin.
