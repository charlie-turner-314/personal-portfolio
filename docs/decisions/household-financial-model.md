# Household financial model

Status: implementation in progress. Base: develop
`36ccf6e263f115f5e064de22f6099a4fe68b02d7` (2026-10-26).
No production migration, main promotion or deployment is authorized.

## Evidence and decisions

The existing model has personal account custodians, live explicit household
account grants, stable linked people, and dated account ownership allocations.
Keep those boundaries. `categories.ts`, cached category reads and transaction
mutations currently disagree: an editable shared transaction cannot select its
custodian's categories. Category instructions and usage are personal. Existing
membership removal clears grants in both directions, but there is no concrete
transition preview, dissolution flow, or durable transition audit. Property and
vehicle ownership still use undated allocations. The saving summary and Sankey
labels imply a funding provenance that recorded transactions cannot establish.

1. Household membership establishes a vocabulary, never financial access. Keep
   one administrator (the current household owner), who manages the vocabulary.
   All current members can apply it to records they can edit. Standalone users
   manage their own vocabulary. Budgets and rules remain personal configurations;
   sharing their category meanings does not publish their amounts or conditions.
2. Separate category definition from private guidance and activity. Canonical
   shared definitions contain name, type, parent meaning, cash-flow default,
   colour and icon only. Never copy descriptions, instructions, usage or linked
   resources into a shared definition. Preserve original private definitions and
   source mappings for audit and personal rules. A common name alone is not an
   equivalence: type, cash-flow purpose and parent meaning must also agree.
   Different meanings remain separate selectable definitions with a visible
   distinction. Migration never destroys the original classification.
3. Keep account custody and import connections unchanged. Explicit account
   grants determine current access to all history of that account (the boundary
   is its earliest recorded date, explicitly shown before sharing). Partial
   historical grants would require pervasive row-level filtering across balances,
   attachments and jobs; do not offer them until supported end to end. Membership
   entry grants nothing. Membership exit deletes grants in both directions.
   Rejoining requires new consent. A moving account remains with its custodian,
   first leaves its old sharing context, then can be shared in the destination.
4. Preserve stable person identities, including departed members. Ownership
   snapshots are complete, effective-dated sets with shares summing to one.
   A change affects records from its effective date, never access or credentials.
   Use the same dated identity resolution for cash, assets and liabilities.
5. My view attributes my economic fraction of permitted records. Household view
   counts the selected permitted accounts once, with visible account coverage.
   Never substitute private net-worth aggregates into detailed household reports.
   Incomplete coverage is explicitly incomplete, not zero. A counterpart outside
   the selected accessible boundary is a boundary movement, never inferred income,
   consumption, gift or loan. Missing counterpart metadata remains redacted.
6. Income less consumption is saving from income. Investments and principal are
   capital movements. Independently recorded balance changes and unreconciled
   differences are separate observations, not derived cash retained/required.
   Ownership transfers use differences in dated economic shares of linked cash
   movements; do not infer which subsequent payment consumed a contribution.
   Proportional diagrams must not claim traced relationships.

## Lifecycle contract

Creating a household is establishing its administrator's vocabulary; inviting
and accepting never publishes accounts. Before accept, share, withdraw, leave,
remove, move or dissolve, show the accessible account changes and history dates,
category mappings/conflicts, personal budget/rule/integration effects and retained
ownership/custody. Recheck the plan under the household transaction lock when
committing; reject stale plans. Only display accounts the previewing actor may
see. A departure notice can describe inaccessible records without revealing them.
Downloaded copies cannot be revoked. Server requests and queued jobs must check
current grants; cross-request financial caches must not bypass those checks.

The single administrator cannot leave while members remain. Offer dissolution:
revoke all financial grants and invitations, remove memberships, retain every
account, credential and person identity. Everyone returns to standalone use.
No ownership or bank-feed transfer accompanies dissolution or a household move.
Category mappings retain readable classifications in every destination.

## Migration and recovery contract

Additive schema first; no automatic account grants or changes to economic rows.
Inventory all category references (transactions/manual and AI, budgets, planned
expenses, forecast overrides, recurring transactions, categorization rules,
subscription suggestions and categorization suggestion reviews), including JSON
references discovered in workers/importers. Report mapping decisions and conflicts
before mutation. Execute mappings transactionally under an advisory lock with a
versioned audit record and deterministic idempotency keys. Preserve amounts,
currencies, dates, links, explicit portions, attachments and source provenance.
Do not merge rules or budget amounts when mappings collide.

Rehearse on a protected release-lab restore, run upgrade twice, verify source
values and absence of new grants, inject failure, and test recovery in a separate
replacement database. Recovery after new writes is forward repair/replay with
mapping provenance; restoring a pre-upgrade dump alone would discard new writes.
Do not use destructive down migrations. Keep backup and credentials private.

## Acceptance and delivery gate

Standalone, two members and outsider; private, shared, joint and changed-share
accounts. Cover category selection and metadata, semantic conflicts, inaccessible
counterparts, date-straddling transfers, refunds, principal/interest, investments,
missing snapshots/FX, every lifecycle transition, warmed caches and queued jobs,
failed/repeated mappings and post-write recovery. Include Jessica's 70,000 private
to joint cash then mortgage principal, Charlie's 35,000 ownership transfer and
35,000 principal allocation, plus other amounts and ratios. Reconcile member sums
only over the same complete permitted record set. Browser verification and a
reviewable PR to develop are required; document exact revisions and concrete UAT.
