# Household financial privacy

Status: implementation in progress; not deployed. This replaces the v0.1.9
whole-workspace household authorization model.

## Product contract

- A login always retains its own financial identity. Joining never transfers,
  merges, hides or exposes existing personal records.
- Accounts start private. The account owner can explicitly share an account with
  selected current household members. Sharing permits viewing and editing the
  account balance, transactions and categorization. Budgets and future plans remain
  personal; actual spending from a shared account is visible to its collaborators.
  Only the owner can change economic ownership or access, delete the account, or manage its credentials.
- Properties also start private. The property owner can explicitly share detail,
  valuations and rental reports with selected current household members. Shared
  members can edit property details and record valuations. Only the owner changes
  economic ownership, linked liabilities, sharing or deletion. Linked mortgage
  balances and tagged transactions additionally require a separate account grant.
  Property grants never expose another private property or account.
- Ownership percentages describe economic ownership, not permission. A placeholder
  or an ownership split never grants access automatically.
- Bank and brokerage connections, Up tokens, AI keys, API keys, import source
  files and connection management remain personal. Shared account collaborators
  may upload transactions into the shared account without seeing another user's
  import files or credentials. A member can connect their own Up token.
- A real joint account has one canonical account record. Each shared account keeps one personally controlled sync connection. A second
  member skips an already-shared account when connecting their own bank login,
  and imports their personal accounts privately. CSV uploads from either member
  target the same canonical account. Never auto-merge accounts by name, amount
  or membership. Provider-ID matches to accessible shared accounts suggest
  skipping and reject creation of a duplicate. Private matches are never exposed.
- Personal account net worth is private by default. A person may share their
  aggregate net worth with selected current household members. This grants the
  aggregate only, never private account, transaction or investment detail.
  All totals must state their currency and avoid double-counting joint balances.
- Search, dashboard activity, budgets, forecasts, analytics, reports, exports,
  investment endpoints, API keys and MCP all follow the caller's resource access.
  Household administration does not grant financial access or impersonation.
- Unsharing, leaving or revocation removes access on the next request, including
  cached reads. Old grants cannot revive when a person rejoins. Already downloaded
  information cannot be recalled. Existing data and bank credentials are retained.
- Private counterpart accounts and transactions must not leak through transfers,
  links, nested relations, ownership detail, error messages or attachments.

## Implementation and migration rules

Keep each resource's original user_id. Replace owner-ID impersonation with
account-access predicates: own account OR explicit grant to a current member of
the same household. Property reads use the corresponding explicit property-access predicate. Other non-account personal resources remain actor-scoped.

Sharing grants are explicit database rows, separate from ownership allocations.
Grant management and membership mutations use the same advisory transaction lock
so sharing cannot race household removal. Delete grants in both directions on
membership exit; read predicates also validate current membership and ownership.

No migration grants access or moves records automatically. Existing owner-held
accounts remain with that owner and become private unless explicitly shared.
The release must explain this transition and give an owner a clear sharing UI.
Never infer a linked member's personal accounts from legacy placeholders.

## Verification required before acceptance

Use three independent logins in one household plus an unrelated household.
Give each private accounts, transactions, investments, credentials and assets;
share only one account between two logins. Verify owner/member symmetry, shared
edits, denied private reads/writes, ID probing, aggregate queries, search, exports,
MCP and API keys. Verify tokens and connection controls remain personal, two Up
connections can coexist, and the second login can skip an existing shared joint
account without creating duplicate balances or gaining token access.
Exercise CSV overlap/reimport and concurrent imports on the canonical account.

Verify private/default and selectively shared net-worth totals, currency handling,
joint-account counting, and no detail disclosure. Warm caches before unsharing,
leave and revocation; verify immediate denial and no revived grants on rejoin.
Run migrations twice on an isolated restored database and compare existing data.
Record the exact develop revision for UAT; obtain acceptance before main/release.
