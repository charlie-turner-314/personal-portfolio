# Household invitations and independent logins

## Required behavior

An owner can invite an existing household placeholder to use an independent login. Acceptance links that login to the same person ID; existing account allocations, assets and history stay intact. Invitations are expiring, single use, revocable and bound to the intended email. A copied link alone must not authorize a different account.

Members can work with shared household finances. Login identity, personal profile, authentication settings and administrator rights remain their own. Household management is restricted to the owner. Members can leave; owners can revoke access without deleting the placeholder or financial records. Existing personal data is preserved when joining; no automatic account/data merge. Access must be resolved on every request so revocation takes effect immediately.

## Implementation sequence

1. Add additive membership/invitation tables and an explicit household access resolver, keeping authentication identity separate from financial data scope.
2. Audit frontend server actions, API proxy, backend/MCP authentication, settings and onboarding for identity/scope boundaries. Apply authorization consistently, including direct API access.
3. Add owner invitation/revocation UI and authenticated acceptance/leave UI, with clear disclosure of shared access. Deliver an invitation link that the owner can share; sending email is not required.
4. Test acceptance, wrong email, expiry, replay, concurrent acceptance, owner-only operations, revocation, isolation, existing-data preservation, and independent login settings. Exercise the full browser journey in the isolated release lab.
5. Feature PR into develop; record exact develop SHA and run upgrade rehearsal plus repository UAT. Inspect Actions availability and use local validation if disabled as authorized by the user.
6. Follow release acceptance/promotion requirements, create immutable release images, inspect Pi runtime/volumes/keys, back up and verify restore, deploy, then check health and existing data.

## Delivery notes

Worktree starts at origin/develop f7005e6. The original checkout contains unrelated uncommitted category-confidence work and is left intact. The user authorized deployment and bypassing disabled GitHub CI/CD; repository acceptance rules still govern promotion to main.

## Validation progress

- Initial source-build candidate f74a741 passed local upgrade preservation checks and both Docker health checks. PostgreSQL integration exercises acceptance races, wrong-email rejection, expiry, replay, invite replacement, revocation, leave, reciprocal invites, and unchanged ownership rows.
- 424 frontend tests passed (six skipped), 48 backend tests passed, TypeScript passed, ESLint reported zero errors, 25 release safety/isolation tests and deployment contract passed.
- Browser testing found anonymous invitation RSC payload reuse after login. fb8016e changes invitation returns to full navigation and adds account switching. Rebuild and full browser journey are required before integration.
- PR #63 targets develop. Workflow dispatch returned HTTP 422: Actions has been disabled for this repository. Use the user-authorized local CI/build path; do not weaken repository branch protection settings.
- Pi read-only discovery: v0.1.8 at aa9fa1a3801a734d0aff58d8ca4862946b21cf77, project personal-portfolio, persistent DB/uploads volumes personal-portfolio_postgres_data and personal-portfolio_uploads_data, deployment checkout /home/charlieturner/personal-portfolio, 8.5 GiB free. Production remains unchanged.
