# Agent-operated testing and releases

## Environments and approval

Feature branch → PR to develop → local UAT of a recorded revision → user acceptance → PR to main → immutable release tag → Pi deployment → existing-data smoke test.

Merging source does not copy databases. Local and Pi databases must remain separate. A branch change does not change an already-built container. `edge` is published from the default branch; use local source builds for develop and version tags on the Pi. Docker publishing supports arm64.

## Local rehearsal

The local `release-lab.py` helper and cached-runtime repair tooling currently live on draft PR #23 (`codex/release-workflow`); use that checkout for these commands until it lands. Production deployment tooling is included in the release branch independently.

Start Docker Desktop if needed. Inspect existing containers using `docker ps` and Compose labels, never dump full environment variables into the conversation.

From a durable checkout of the candidate revision:

```sh
python3 scripts/release-lab.py prepare --source-db syllogic-postgres --source-app syllogic-app
python3 scripts/release-lab.py up
python3 scripts/release-lab.py accounts
python3 scripts/release-lab.py smoke
python3 scripts/release-lab.py status
```

The lab uses its own project, volumes, images, and localhost port 8088. It copies the source DB and encryption keys, builds current source, restores into a new DB, runs the migration runner twice, checks old column values and counts in six core tables, and starts the app/backend. Workers and beat are omitted to avoid automatic external sync from restored credentials. Do not manually sync restored bank connections in UAT.

Preserve the source `BETTER_AUTH_SECRET` with the database: stored JWKS private keys are encrypted with it. Generating a new auth secret for a copied DB causes authenticated server rendering to fail even when the sign-in API succeeds. The lab now retains that secret. Keep the lab private because it contains copied authentication keys and sessions. `accounts` also runs cookie-authenticated page checks; `smoke` can repeat those independently.

`.release-lab/manifest.json` records the revision and source; `verification.json` records the data checks. Backups, environment values and randomly generated test passwords remain local in that ignored directory. Use `test-accounts.json` for the populated `demo-uat@example.test` and empty `fresh-uat@example.test` accounts. The supplied demo is EUR/USD-oriented, not an Australian acceptance fixture. It is seeded explicitly, not on registration or deployment.

Prepare only once per lab. A failed restore must be investigated before retrying; the script never drops the database. Use a separate checkout and review project/volume naming before creating another simultaneous lab. Run `verify` before adding test accounts: intentional test changes will alter the preservation comparison. `stop` retains data. Rebuilding with `up` uses current source; record any subsequent revision in the acceptance evidence.

This is a database upgrade rehearsal, not a full production restore certification: uploads are not copied to the lab, external providers are not exercised, and not every table is compared. A local backup cannot certify the Pi's schema/data. Repeat using a Pi backup once connectivity is available.

Acceptance: login with both accounts; complete fresh onboarding; create an account; import CSV; inspect transactions, budget, ownership splits and investments; logout/login; inspect health and migration logs. Record candidate SHA, report, and acceptance in the release PR.

## Pi discovery (read only first)

```sh
ssh -o BatchMode=yes -o ConnectTimeout=5 pi 'hostname; uname -m; docker ps --format "{{.Names}} {{.Image}}"'
```

Inspect the app's `com.docker.compose.project`, config-files and working-directory labels; image revision labels/digests; Postgres mounts; database host/name (redact password); persistent env file; encryption-key presence; uploads mount; exposed URL; free disk space. Save non-secret facts here once verified. Do not assume this host uses the current Compose names or release directory.

## Promotion and deployment

After user acceptance, open a develop-to-main PR, wait for required checks and merge. Tag that resulting main commit `vX.Y.Z` using the next approved version and wait for both arm64 image publications. Keep the tested release identifiable; do not deploy a moving edge tag.

Use **merge commits** (not squash/rebase) for promotions and main-to-develop synchronization. Both long-lived branches allow merge commits while still requiring PRs, current checks, resolved conversations, and administrator enforcement. Feature PRs can still be squashed. After promotion, synchronize main's merge ancestry back into develop through a PR before the next feature cycle. Release publishing generates version-pinned bundles without writing directly to protected main.

Before stopping writers, the deploy helper compares persistent volume identity and database/auth/encryption configuration with running containers. It verifies application image revision labels against the release commit, backs up data and uploads, tests restoring the dump into a separate disposable database, applies migrations twice, and compares hashes of existing columns in six core tables before restarting writers. A failed restore leaves its disposable database for diagnosis; do not remove production volumes. Image digests and old container configuration are retained in the restricted backup directory.

On a Pi already validated against the current Compose layout, check out the release tag in its durable deployment repository, then:

```sh
bash scripts/pi-release.sh vX.Y.Z /absolute/path/to/production.env
```

The script verifies the tag belongs to main, pulls images, stops writers, saves a DB dump, uploads archive, environment/keys and previous image references in restricted `.release-backups/`, runs migrations, and waits for services. The backup is on the same machine: copy it securely off-device for disaster recovery. It is not an automatic rollback. The original env file is retained; use `APP_VERSION=$(cat .release-backups/current-version)` with future Compose commands or update its APP_VERSION to the successful tag. Confirm login, representative old transactions/holdings and upload retrieval after deploying.

If migration fails, inspect the saved log while writers remain stopped. Manual SQL migrations can partially apply. Do not roll application images back over a changed schema without compatibility checks. Restore the dump into an empty replacement database, restore matching uploads/keys, and use the recorded previous image version. Never use volume deletion as rollback.

## Discovery on 2026-10-11

- Local existing project: `syllogic-develop-uat`; database volume: `syllogic-develop-uat_postgres_data`; two existing users.
- Existing local images: `syllogic-frontend:local` / `syllogic-backend:local`, without a verified source revision; Compose labels reference `/private/tmp/syllogic-develop`, whose source checkout is no longer available. Caddy exited; app/backend healthy after Docker startup.
- SSH alias `pi` now uses `charlieturner@192.168.1.107`; host-key verification and public-key authentication succeed. The old address and username were incorrect.
- Pi: `raspberrypi`, arm64; deployment checkout `/home/charlieturner/personal-portfolio`, Compose project `personal-portfolio`, config `deploy/compose/docker-compose.yml`, persistent environment `deploy/compose/.env`. Checkout is clean at `550f69d78ded3f1d1419a8842bd4a3efceddd99c`; running frontend image revision matches it, using the moving `edge` tag.
- Pi URL: `http://192.168.1.107:8080` (responds with login redirect). Port 80 belongs to the separate Strava deployment; do not alter that stack. Portfolio HTTPS host port is 442.
- Pi database is internal `postgres/finance_db`, stored in `personal-portfolio_postgres_data`; uploads use `personal-portfolio_uploads_data`. Auth, internal-auth and data-encryption keys are present. These are separate from local lab volumes. Pi had 27 GB free during discovery. No Pi backup or migration has yet been performed.
- Candidate for this rehearsal: develop `e586ede` (investment ingestion and SYL-42 merged).

Pi deployment helper must be reviewed against the discovered Pi layout before first use; it has not yet been exercised on that host.

### Promotion attempt on 2026-10-11

User explicitly accepted develop `e586ede` for promotion. PR #24 (`develop` to `main`) records that acceptance and local rehearsal evidence. Draft workflow PR #23 remains separate and is not included in the accepted application revision.

Promotion is blocked: GitHub reports merge conflicts and a failing CodeQL gate. Main's unique commits are earlier release promotions (#1 and #15); reconcile their history without discarding changes, and use merge commits for long-lived develop-to-main promotions to preserve ancestry. CodeQL reports seven blocking annotations: three request-forgery findings and four filesystem-path findings. In particular, `importRevolutCsv` reads a caller-supplied path and local storage joins paths without a root-containment check. Review/remediate and test before promotion; do not bypass or dismiss the security gate merely to deploy. Main and the Pi remain unchanged. Do not create a release tag until the promotion is clean and checks pass.

### Local troubleshooting

If a build stalls before downloading public images, inspect `ps` for a hanging `docker-credential-desktop`. A temporary, credential-free Docker config plus an explicit Docker Desktop socket can isolate the issue without changing the user's saved logins. Only use this for public images; private registry pulls still require authentication.

Check both host disk space and Docker VM disk space. This machine's Docker VM was full even though the Mac had 21 GiB free. Reclaim reviewed, unused build cache and obsolete untagged Syllogic images; preserve active images and all data volumes. Do not use broad system/volume pruning.

When a full build is unavailable, `python3 scripts/release-lab.py rehearse --cached-image syllogic-frontend:local` mounts the candidate migration runner and SQL into the cached frontend runtime. It restores the backup and runs migrations twice, then compares existing values. Record this explicitly as migration-only evidence, not full application acceptance.

`cached-bootstrap` can then start cached app/backend images against that isolated upgraded DB for account preparation. This is not the new candidate UI. `runtime.json` records the runtime mode when the helper completes. Once space is available, `up` replaces those images with source builds. With test accounts present, it retains the original pre-test verification report rather than comparing intentionally changed data.

### Rehearsal result on 2026-10-11

Candidate migration SQL and runner from `e586ede` applied twice successfully to a restored copy of the old local database. Existing values were preserved in users (2), auth accounts (2), accounts (2), transactions (29), holdings (0) and broker trades (0). Empty investment tables mean this does not test migration of existing investment history. The original database was not modified.

The candidate application build initially hit Docker's 24 GB disk capacity. Unused build cache and six unreferenced, untagged old Syllogic images were removed; data volumes and running images were retained. After increasing the allocation and applying/restarting Docker, its filesystem reported 86.4 GB capacity. `python3 scripts/release-lab.py up` then built both application images successfully and replaced the cached runtime at http://localhost:8088. Pi access still needs a reachable address/network.

The successful source build used workflow branch commit `b4b3abf`; its frontend/backend source is identical to develop `e586ede98be6b90750089a82297d3b7efe81e6a1`. Both migration runs succeeded and app/backend health checks passed. Immediately before and after this upgrade, hashes of all recorded columns matched across users (4), auth accounts (4), accounts (7), transactions (3,188), holdings (8), and broker trades (8). This includes the populated test accounts; it supplements the original pre-seeding preservation report. Authenticated demo dashboard, transactions, and investments returned HTTP 200; the fresh account reached onboarding. This is now the candidate UI for user testing, not the older cached UI. Main and the Pi were not deployed.

Account preparation completed on the isolated DB: `demo-uat@example.test` has 3,159 generated transactions and 8 holdings; `fresh-uat@example.test` is unseeded. Both logins were verified. Credentials are in `.release-lab/test-accounts.json`; seed results are in `.release-lab/seed.log`. The original two users and their 29 transactions remain in the source DB. The cached backend seeder was used, so this does not certify new investment-ingestion user journeys.

Follow-up repair: digest `3230111203` was traced to a newly generated auth secret that could not decrypt the copied JWKS. `python3 scripts/release-lab.py repair-auth` restored the matching source secret in the lab configurations and recreated only the lab app. No keys or financial records were deleted. Authenticated dashboard, transactions and investments returned HTTP 200; the fresh account reached `/step-1`. Existing browser cookies signed with the discarded secret may require signing in again.
