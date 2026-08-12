# Australian bank connectivity strategy

Status: Accepted for SYL-8 spike
Date: 2026-08-12
Linear: SYL-8

## Context

Syllogic is an open-source, self-hostable personal finance app. It already has a working CSV import path and an Enable Banking integration aimed at European banks. The current live-bank path is provider-specific in naming and flow:

- `backend/app/integrations/base.py` defines a small `BankAdapter` around account and transaction normalization.
- `backend/app/routes/enable_banking.py` owns institution listing, auth initiation, session exchange, account mapping, sync trigger, status, and disconnect routes.
- `backend/tasks/enable_banking_tasks.py` owns scheduled and on-demand sync work for Enable Banking sessions.
- `backend/app/services/sync_service.py` already consumes canonical `AccountData` and `TransactionData`, so it is the best seam to keep provider-neutral.
- `frontend/app/(dashboard)/settings/connect-bank/bank-picker.tsx` hardcodes Enable Banking European countries.
- `frontend/lib/actions/bank-connections.ts` calls `/api/enable-banking/*`.
- `frontend/app/api/enable-banking/callback/route.ts` handles the Enable Banking callback.
- `frontend/components/settings/account-mapping-wizard.tsx` can be reused if copy and identifiers become provider-neutral.

Australian live banking should be built on the Consumer Data Right (CDR) rather than screen scraping. Banking CDR is active, energy is active, and non-bank lending is rolling out from 2026 according to the CDR rollout page.[^cdr-rollout] Australian banking industry guidance describes CDR-shareable banking information as including identity, account balances and product types, rates and fees, and transaction activity.[^aba-open-banking] The official provider register is the source of truth for accredited data recipients, data holders, and representative arrangements.[^cdr-providers]

## Decision

Use a provider-mediated Australian CDR integration for managed/hosted Syllogic deployments, and keep CSV import as the default self-host-safe path.

For the first Australian live-bank implementation, prefer an Australian CDR aggregator/platform that can support a representative, sponsored, or equivalent contractual access model. Shortlist Fiskil and Basiq first, with Adatree and Mastercard Open Finance Australia as credible alternatives to evaluate commercially. Do not pursue direct unrestricted ADR accreditation as the first implementation path.

For open-source self-hosted deployments, do not enable Australian CDR by default. A self-hosted operator should either:

- use CSV import/export, or
- explicitly configure their own supported CDR provider credentials and accept the operational/privacy obligations that follow.

Syllogic must not ask users for internet-banking passwords or ship a screen-scraping path.

## Decision Criteria

- Coverage for Australian accounts, balances, and transactions.
- Consent UX support, including expiry, renewal, withdrawal, and receipt metadata.
- Compliance burden for a small product team and for self-hosted operators.
- API maturity and fit with the existing canonical account/transaction sync service.
- Token and identifier storage model.
- Data minimisation, deletion, and audit requirements.
- Commercial viability and contract risk.
- Ability to preserve the European Enable Banking path without making the app region-specific.

## Options Compared

| Option | Strengths | Weaknesses | Fit |
| --- | --- | --- | --- |
| Fiskil Banking API | Public docs describe access to CDR banking data clusters including accounts, transactions, balances, direct debits, scheduled payments, payees, and product reference data. Fiskil says it handles FAPI 2.0, token management, data-holder quirks, and supports ADR, representative, and sponsored pathways.[^fiskil] | Commercial terms need validation. Using a normalised API creates provider dependency and requires contract/privacy review. | Strong first shortlist for hosted AU bank sync. |
| Basiq | Basiq positions itself as an AU/NZ open banking API platform with access to account and transaction history from 135+ financial institutions.[^basiq-home] Its access-model guidance covers ADR, sponsored affiliate, principal/representative, trusted adviser, CDR insights, and OSP models.[^basiq-access] | Now tied into Cuscal commercially; pricing and self-host redistribution terms need validation. Some models still require accreditation or sponsor oversight. | Strong first shortlist, especially if pricing and representative model fit. |
| Adatree | Developer portal describes one REST API for CDR data, with banking and energy live and connected to every data holder.[^adatree-dev] Access guidance is explicit about ADR overhead, representative requirements, and limited CDR Insights use cases.[^adatree-access] | Representative path still requires mature technical controls, policies, and principal approval. Adatree may be more platform/compliance oriented than lightweight personal-finance sync. | Credible alternative, especially for representative/compliance-heavy path. |
| Mastercard Open Finance Australia | Enterprise-grade open-finance provider with Australian CDR positioning and broader open-finance roadmap.[^mastercard] | Likely enterprise sales motion, heavier commercial process, and less obviously self-host friendly. | Keep as enterprise fallback if Fiskil/Basiq/Adatree do not fit. |
| Direct unrestricted ADR | Maximum control, direct data-holder access, ability to sponsor others later. | Highest compliance and cost. ADRs must meet legal and IT requirements, collect/use only needed data, maintain consent and reporting records, support deletion, and comply with privacy safeguards.[^cdr-obligations] Adatree also describes direct ADR as carrying direct ACCC/OAIC accountability, audits, liability, and bespoke technical/regulatory requirements.[^adatree-access] | Not viable for first implementation. Revisit only after product-market proof. |
| CSV-only fallback | Best fit for open-source self-hosting, no CDR participant dependency, no live consent/token lifecycle. Preserves existing import path. | No automatic refresh, weaker reconciliation, users must handle bank export formats. | Required fallback and default self-host posture. Not enough for hosted live banking. |

## Recommendation

1. Build SYL-9 around a provider-neutral bank connection abstraction, not around "Enable Banking plus Australia".
2. For Australian live data, evaluate Fiskil and Basiq commercially first, then Adatree, then Mastercard. Selection should depend on representative/sponsored availability, pricing for personal-finance use, supported data clusters, sandbox quality, webhook/cursor support, token model, and self-host terms.
3. Keep CSV import as the primary Australian setup path until an AU CDR provider is configured and legally reviewed.
4. Treat CDR data as higher-sensitivity provider data even after it is normalised into accounts and transactions.
5. Preserve Enable Banking behavior while moving route names, database fields, and frontend copy toward provider-neutral concepts.

## Privacy And Security Implications

CDR is consent based. The CDR obligations page says the consent process must identify the recipient, let consumers choose data types, set sharing duration up to 12 months, explain withdrawal, issue a receipt, disclose fees, explain redundant-data deletion, and surface affiliate/sponsor arrangements where relevant.[^cdr-obligations] The same page describes privacy safeguards, CDR policy, records, reporting, and IT requirements for accredited recipients.[^cdr-obligations]

For Syllogic this means:

- Self-host default remains CSV-only. The app should not imply that a home operator is automatically covered by Syllogic's hosted provider arrangements.
- Hosted AU bank sync must clearly disclose the selected CDR provider, access model, data clusters, consent duration, expiry, renewal, withdrawal, and deletion behavior before redirecting the user.
- Provider tokens, provider connection ids, consent ids, customer ids, account identifiers, and raw consent/session payloads must be encrypted or avoided. Existing field-level encryption and blind indexes for account identifiers should be reused.
- Raw provider session/consent data must be retained only while needed. The current Enable Banking mapping flow already clears `raw_session_data` after account mapping; AU CDR should keep that minimisation behavior.
- Sync should request only the clusters Syllogic needs for the feature: accounts, balances, and transactions. Identity, payees, direct debits, or scheduled payments should be opt-in when a specific product workflow requires them.
- Withdrawal/revocation must stop sync immediately. Syllogic should store enough consent metadata to show status and audit behavior without storing unnecessary raw CDR payloads.
- Deletion controls need a product/legal decision: users may want to keep historical personal finance records, but CDR redundant-data deletion obligations can apply to CDR data. Separate provider credentials/raw CDR payload deletion from user-owned normalised transaction-history retention.
- No screen scraping or bank-password collection should be implemented.
- Sponsored affiliate and representative paths still carry obligations. OAIC guidance says sponsored affiliates need a written sponsor contract, cannot collect directly from data holders, and remain liable in their own right for handling CDR data.[^oaic-sponsored]

## Engineering Plan For SYL-9

### Backend provider abstraction

Introduce a provider-neutral bank connectivity layer above the existing `BankAdapter`.

This should follow the Consumer Data Standards bias toward RESTful, implementation-agnostic, consistent, extensible APIs and positive consumer/developer experience.[^cdr-standards]

Proposed interfaces:

- `BankConnectionProvider`
  - `provider_key`
  - `data_region`
  - `list_institutions(country_or_region)`
  - `create_consent_redirect(user_id, institution_id, scopes, redirect_uri)`
  - `exchange_callback(params)`
  - `fetch_connection_accounts(connection)`
  - `fetch_transactions(connection, account_external_id, cursor_or_range)`
  - `fetch_balances(connection, account_external_id)`
  - `revoke_connection(connection)`
  - `refresh_or_validate_consent(connection)`
- Keep `AccountData` and `TransactionData` as canonical sync payloads, but add optional fields as needed:
  - `institution_id`
  - `account_mask`
  - `bsb`
  - `provider_account_number_last4`
  - `available_balance_as_of`
  - `raw_identifiers` in encrypted provider metadata, not plaintext columns unless required for matching.

Implementation shape:

- Keep `EnableBankingAdapter` working.
- Add a provider registry/factory keyed by `bank_connections.provider`.
- Move shared route concepts to `/api/bank-connections/*`.
- Keep `/api/enable-banking/*` as compatibility wrappers or deprecate in a controlled follow-up.
- Split `tasks/enable_banking_tasks.py` into a provider-neutral dispatcher plus provider-specific sync implementation.
- Continue sending canonical payloads into `SyncService` so categorisation, transfer linking, account balance anchoring, and post-import pipelines do not care which provider supplied the data.

### Migration needs

Current `bank_connections` columns are Enable Banking shaped: `session_id`, `aspsp_name`, and `aspsp_country`. Add provider-neutral fields while preserving backwards compatibility:

- `provider_connection_id`
- `provider_consent_id`
- `provider_customer_id`
- `provider_institution_id`
- `provider_institution_name`
- `provider_metadata jsonb`
- `scopes jsonb`
- `consent_collected_at`
- `revoked_at`
- `data_region` with existing Enable Banking rows backfilled to `EU` from `aspsp_country`, and AU CDR rows set to `AU`

Indexes/constraints:

- Unique partial index on `(user_id, provider, provider_connection_id)` where `provider_connection_id IS NOT NULL`.
- Index `(user_id, provider, status)`.
- Index `(status, consent_expires_at)`.

Compatibility steps:

1. Add new nullable fields.
2. Backfill `provider_connection_id = session_id`, `provider_institution_name = aspsp_name`, and `data_region` for existing rows.
3. Update code to read provider-neutral fields first and fall back to legacy fields.
4. In a later cleanup, loosen or retire `session_id NOT NULL` after all provider code writes `provider_connection_id`.

### UX flows

Replace the current Europe-only bank picker with a provider-neutral connection flow:

1. Choose data path:
   - CSV import
   - Bank sync
2. If Bank sync is selected:
   - Show configured regions/providers only.
   - If no AU provider environment variables are configured, make CSV import the primary path and explain that AU live bank sync is not configured for this deployment.
3. Choose institution:
   - Europe: Enable Banking institution picker.
   - Australia: configured CDR provider institution picker.
4. Consent disclosure:
   - Provider name and access model.
   - Data clusters requested.
   - Consent duration and expiry.
   - How to disconnect/revoke.
   - What Syllogic stores.
5. Redirect and callback.
6. Account mapping:
   - Reuse `account-mapping-wizard`.
   - Replace IBAN-specific language with "bank account identifier".
   - Support AU metadata such as BSB/account-number display when provider supplies it.
7. Initial sync.
8. Settings state:
   - Connected, syncing, expired, revoked, disconnected, unsupported provider.
   - Reconnect/renew consent.
   - Disconnect/revoke.
   - Fall back to CSV import.

## Follow-up Issues

- SYL-9: implement provider-neutral bank connection routes, registry, and AU provider adapter skeleton.
- SYL-10: improve Australian CSV presets and mapping suggestions; this remains the default self-host path.
- SYL-11: use provider-neutral sync metadata for reconciliation and data-quality reporting.
- SYL-32: add in-app CDR provider disclosure, data residency posture, export/delete controls, and self-host warnings.

## Risks

- Commercial terms may block a provider that looks technically ideal.
- Representative or sponsored access still requires security maturity, policies, contracts, and review.
- A normalised aggregator API can hide useful CDR details needed for consent auditing.
- CDR rules and rollout scope change; provider implementation should keep source links and assumptions current.
- Self-hosted deployments can accidentally imply compliance they do not have if the UI uses generic "Open Banking" language without provider-specific disclosure.
- Existing Enable Banking fields and routes can leak Europe-specific assumptions into AU support if not neutralised first.

## Verification Checklist

- Compares at least 3 viable Australian data options plus CSV fallback: Fiskil, Basiq, Adatree, Mastercard, direct ADR, CSV.
- Recommendation distinguishes hosted/managed deployment from self-hosted deployment.
- Privacy/security section covers third-party data flow, consent expiry, revocation, deletion, encrypted identifiers, raw session retention, and screen-scraping avoidance.
- Engineering plan names backend adapter changes, provider-neutral routes/tasks, migration fields, and UX flows.
- Migration plan preserves existing Enable Banking rows.
- UX plan covers first-time connection, unsupported AU provider configuration, expired consent, reconnect/renew, disconnect/revoke, account mapping, and CSV fallback.

## Sources

[^cdr-obligations]: Consumer Data Right, "Legal obligations for data recipients", https://www.cdr.gov.au/for-providers/legal-obligations-data-recipients
[^cdr-providers]: Consumer Data Right, "Current providers", https://www.cdr.gov.au/find-a-provider
[^cdr-rollout]: Consumer Data Right, "Rollout", https://www.cdr.gov.au/rollout
[^cdr-standards]: Consumer Data Standards, "CDR Data Standards", https://consumerdatastandardsaustralia.github.io/standards/
[^fiskil]: Fiskil, "Access CDR-Designated Banking Datasets in Australia", https://www.fiskil.com/grow/banking-api/open-banking-au/cdr-data-access
[^basiq-home]: Basiq, "Open Banking API Platform", https://www.basiq.io/
[^basiq-access]: Basiq, "Open Banking Access Models - Consumer Data Right", https://www.basiq.io/resources/open-banking-access-models.html
[^adatree-dev]: Adatree, "CDR Developer Portal", https://developer.adatree.com.au/
[^adatree-access]: Adatree, "CDR Access Methods FAQ", https://adatree.com.au/access-methods-faq/
[^oaic-sponsored]: OAIC, "Sponsored accreditation model: privacy obligations of an affiliate", https://www.oaic.gov.au/consumer-data-right/consumer-data-right-guidance-for-business/privacy-obligations/sponsored-accreditation-model-privacy-obligations-of-an-affiliate
[^aba-open-banking]: Australian Banking Association, "Open Banking", https://www.ausbanking.org.au/priorities/open-banking/
[^mastercard]: Mastercard Developers, "Mastercard Open Finance Australia", https://developer.mastercard.com/open-finance-au/documentation/
