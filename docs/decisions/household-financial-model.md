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
   one household administrator for membership. A category creator manages its
   definition; all current members can apply the shared vocabulary to records
   they can edit. This uses existing custody permissions rather than adding roles.
   Standalone users manage their own definitions. Budgets and rules remain personal configurations;
   sharing their category meanings does not publish their amounts or conditions.
2. Separate category definition from private guidance and activity. Canonical
   shared definitions expose name, type, cash-flow default, colour and icon only.
   A vocabulary-entry relation retains stable source definition IDs; no financial
   reference is rewritten just to change its vocabulary. Never copy descriptions, instructions, usage or linked
   resources into a shared definition. Preserve original private definitions and
   source mappings for audit and personal rules. Financial type and cash-flow
   purpose are immutable after creation; a different meaning gets a new ID.
   Retirement is scoped to each vocabulary, so a former creator cannot disable
   another household’s retained selection. A common name alone is not an
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
Category mappings retain readable classifications in every destination. At join,
copy safe definition IDs into the destination vocabulary; at exit, retain the
whole safe vocabulary for both sides before removing membership. Copy no activity
or private instructions. Duplicate names remain distinct IDs and visible
conflicts. This avoids destructive classification migration and budget collisions.

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

## Ownership implementation detail

Accounts, properties and vehicles now use one complete-set resolution rule in
TypeScript and Python. Properties/vehicles receive additive dated tables. Existing
legacy owner rows stay intact as provenance; migration supplies a baseline at
0001-01-01, preserving their prior timeless meaning. Equal thirds use a final
residual at stored precision so a complete set totals exactly one. Invalid legacy
partial/mixed explicit splits fail closed; they are not silently normalized.

The generic owner endpoint writes dated facts for all three resource types;
legacy owner tables are no longer an alternative writer. Edits require an
explicit effective date when allocations change. Stable linked login identities
resolve through retained people, independently of present membership. Dated
history prevents deleting a person. Economic changes never grant resource access.

## Currency and missing observations

An account’s stored functional values are in its custodian’s functional currency.
They cannot be relabelled as a collaborator’s currency. Reporting converts to the
viewer’s currency at the observation date, uses native amounts directly when the
native currency already matches, and uses only dated positive direct/inverse
rates available on or before the observation. Missing conversion or valuation is
unknown, never zero. Complete net-worth totals become unavailable while the
breakdown identifies its known values and missing permitted records. Cash history
keeps gaps when an included economic share lacks a balance observation.

## Reporting boundary implementation

The selected permitted record set is the sole source for activity and its linked
peers. Dates and selected accounts apply to all legs. Budgets use these same
facts, comparing personal category movement plans while showing consumption and
capital separately. A missing conversion is unavailable, including in plan
actuals; refunds and investment returns reduce their own movement purpose.

A closed, balanced, visible linked set can establish an economic redistribution
from differences in dated shares. An incomplete set establishes only a boundary
movement. Thus Charlie may see his 35,000 inflow and 35,000 principal allocation
without learning Jessica's private source balance or transaction. Jessica can
see the 35,000 redistribution out when both her source and joint destination
are legitimately included. This difference in explanation is intentional: a
private peer is never read to make another member's report balance.

Sankey residuals are labelled calculated net inflow/outflow. They are differences
between included movements, including capital and boundary transfers, rather
than saving, funding requirements or independent cash balance observations.

## Transaction display and export

A transaction's original bank amount/currency is immutable financial input for
editing and purpose portions. Reports may attach a separate dated attributed
amount converted to the viewer's currency. The transaction list shows both;
amount filters/sort use the attributed amount. Unknown conversion remains
unavailable even when an amount range is selected. Movement totals are cash
movement totals, not an income or consumption classification.

Category detail rows represent consumption portions, including refunds and
linked netting, rather than all negative bank transactions. Their totals use the
same entries as the category chart. Full bank facts remain available in details.

CSV exports re-fetch every selected record using current permissions before
creating a new file, reject partial authorization, and label original versus
attributed amounts explicitly. Original explicit portions and classification
IDs are retained in the file. Revocation cannot erase existing downloaded copies.

## Explicit coverage and unavailable selections

Historical activity includes a custodian's closed accounts; closing an account
does not erase its records. Household access always follows the current explicit
grant, so past membership or a revoked grant cannot expose historical records.
Current cash/net-worth balances use active accounts, separately labelled from
historical activity coverage.

An explicit selection containing an unavailable account is rejected as a whole.
It cannot silently become a subset with zero for the missing account. The same
response applies to withdrawn, private and nonexistent IDs and contains no
private name or total. Report pages offer a clear-filter link that preserves
other context. Every final record query still enforces live account access.

## Backend report parity

API and MCP analytics use the same financial boundary rules as frontend activity.
Python maps explicit purpose portions from the existing schema. Consumption is
not all negative bank amounts, income is not every credit, and a classification
uses the manual override or AI fallback once. Category IDs define comparisons;
names do not merge definitions. Linked amounts use immutable leg weights, so
row iteration order cannot remove a secondary before summing a primary.

Recorded cash observations remain independent of movement calculations. Exact
opening/closing cash observations are required for reconciliation. Historical
balance APIs do not reverse-engineer balances from a current balance and later
transactions. Current cash excludes loans/cards; liabilities and gross assets
are independently attributed. Holding values replace their account's valuation,
and missing holding values/FX make complete totals unavailable. A current
financial summary explicitly labels its balance date separately from flow dates.

## Personal newsletters and delivery-time access

Newsletter reports explicitly show the named report owner's economic view and
permitted account coverage. Current cash totals use active cash accounts;
liabilities and investment values retain their own labels. Consumption and income
filters use classified portions, while movement lists preserve both attributed
values and original bank units. Missing values remain unavailable.

A queued run and rendered email are snapshots, not continuing authorization.
Before sending, the worker refreshes recipients and report configuration and
rebuilds the financial payload under live access. If access or displayed financial
facts changed, it fails the run for a fresh retry instead of sending the stale
copy. Already delivered/downloaded copies cannot be revoked.

Generated mirror descriptions never need a private source account's name.
New mirrors use generic text; legacy source text is preserved in storage but
projected safely in API/MCP reads and search predicates. Personal guidance,
enrichment and integration IDs are custodian context, not shared classification.

## Automatic links and explicit original purposes

An automatic transfer relationship does not prevent declaring the original bank
record's purposes. Its visible derived mirror records the other leg; it is never
a second allocation. Peer purpose checks apply the same selected dates/accounts
and access boundary for manual and automatic groups. An isolated mirror remains
a boundary movement and does not expose the original record's private purpose.
Stored legacy annotations on a generated mirror remain audit data, while its
reporting purpose stays Transfer. Ordinary original bank portions are preserved.

Independent cash reconciliation must not use balances calculated from the same
transactions. Existing daily-balance writers include such calculations. Additive
observation provenance and writer auditing are required before final delivery;
unknown legacy observations must fail closed for reconciliation, without losing
or changing their recorded numeric values.

## Balance provenance implementation decision (before schema change)

Daily balance caches contain both supplied observations and transaction-derived
estimates. Add explicit balance_source and currency-unit metadata to those rows.
Sources bank, statement and manual can support independent reconciliation;
calculated, valuation and legacy cannot. Existing rows become legacy, never
retroactively certified. Preserve their original rows in an idempotent revision
archive as well as leaving migration-time numeric values untouched. New missing
conversions/calculations use nullable values, never native-as-functional fallbacks.

Calculated writers must not overwrite supplied independent observations or
unknown legacy values. They may calculate later estimates from a usable dated
anchor plus subsequent transactions, with each transaction converted into the
account's currency at its own date. Estimates/carry-forwards stay calculated.
Statement/manual writers identify their provenance persistently; account
consolidation copies it. Unknown legacy records remain available as historical
recorded values, with explicit limitations, and cannot prove reconciliation.

Exact opening/closing reconciliation accepts only independent-source rows in
the actor's currently permitted accounts, then converts native/declared functional
units and applies ownership at each boundary. Current/history balances may show
recorded or estimated values but must not call those estimates independent.
