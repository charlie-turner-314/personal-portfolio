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
