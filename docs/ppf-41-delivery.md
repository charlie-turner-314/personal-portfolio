# PPF-41: multi-account CSV imports

Issue: https://linear.app/ct-syllogic/issue/PPF-41/support-generic-multi-account-csv-imports-and-transfer-linking

## Plan and contract

1. Extend generic column mappings with source account, destination account and bank transaction ID. Presets suggest columns only.
2. Discover aliases across the complete file. Require an explicit owned-account selection or external/unmapped choice for every alias. Do not infer account ownership from names.
3. Preview each source row once with its account routing. Both owned sides produce one atomic debit/credit pair linked through existing internal transfers; exclude both from cashflow analytics. One owned side remains external. Explicitly unmapped rows are reported as needing attention.
4. Validate every target account again at enqueue and persistence. Reject self-transfers and cross-currency pairs because the export has only one amount. Shared balance/fee columns must be unmapped for multi-account mode.
5. Use deterministic bank-reference identities for retry safety and an advisory transaction lock for concurrent imports. Preserve the existing single-account path.
6. Recalculate all affected accounts through the existing post-import pipeline. No schema migration is required.

## Verification and delivery

- Synthetic frontend tests cover column suggestions, full-file alias discovery, time-first dates, explicit external choices, and routing.
- Isolated PostgreSQL integration tests cover transfer links, analytics exclusion, both account balances, duplicate/retry behavior, ownership checks and atomic rollback.
- Exercise the supplied CSV locally; do not commit its contents or upload it as a public fixture.
- Feature PR targets develop. Wait for required CI, images, Compose E2E and CodeQL.
- Record the tested develop SHA and complete local release-lab and fresh-account acceptance checks.
- Obtain acceptance of the tested revision before promotion under repository governance, unless explicitly approved in the session.
- Promote with a merge PR, publish an immutable version, inspect current Pi identity, back up and rehearse restore, deploy with pi-release.sh, and verify health, migrations and existing data.

## Evidence

- 30 frontend tests passed, including all 50 supplied CSV rows and 22 transfer rows, plus arbitrary semicolon-delimited columns with signed comma-decimal amounts and no transaction IDs.
- 14 backend integration/pipeline tests passed on a dedicated disposable PostgreSQL instance.
- TypeScript and targeted ESLint checks passed.
- Pi discovery: v0.1.4 at image revision 14d59b44582b066696cb895242b24eea775c11c5, project personal-portfolio, existing postgres/uploads volumes retained, 12 GiB free. Production has not been modified.
- Files without bank transaction IDs use the full date token, amount, description and confirmed accounts as their identity. Identical rows are shown as duplicates; a unique reference column is needed to distinguish otherwise identical real payments.
- Overlap with older single-account imports fails for review instead of double-counting an existing leg. Cross-currency transfers require separate currency amounts and remain unsupported by this one-amount workflow.
