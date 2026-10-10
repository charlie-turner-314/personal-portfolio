#!/usr/bin/env bash
# Run on the Pi after reviewing and approving the release tag.
set -euo pipefail
umask 077
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${1:?Usage: bash scripts/pi-release.sh vX.Y.Z /absolute/path/to/production.env}"
env_file="${2:?Supply the existing production environment file}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'An immutable vX.Y.Z release tag is required'; exit 1; }
[[ "$env_file" = /* && -f "$env_file" ]] || { echo 'Environment file must be an existing absolute path'; exit 1; }
cd "$root"
git diff --quiet && git diff --cached --quiet || { echo 'Commit/stash source changes first'; exit 1; }
git fetch origin main --tags
target="$(git rev-parse "$tag^{commit}")"
git merge-base --is-ancestor "$target" origin/main || { echo 'Tag must belong to origin/main'; exit 1; }
[[ "$(git rev-parse HEAD)" = "$target" ]] || { echo "Check out $tag in the deployment checkout first"; exit 1; }
export APP_VERSION="$tag"
compose=(docker compose --env-file "$env_file" -f "$root/deploy/compose/docker-compose.yml")
backup="$root/.release-backups/$(date -u +%Y%m%dT%H%M%SZ)-$tag"
mkdir -p "$backup"
cp "$env_file" "$backup/production.env"
"${compose[@]}" config > "$backup/resolved-compose.yaml"
"${compose[@]}" images --format json > "$backup/previous-images.json"
"${compose[@]}" pull
# Stop all writers before taking a consistent application backup.
"${compose[@]}" stop app backend worker beat mcp
trap 'echo "Release stopped. Backup: $backup. Inspect migration logs before restarting; do not delete volumes."' ERR
"${compose[@]}" exec -T postgres sh -c 'exec pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$backup/database.dump"
test -s "$backup/database.dump"
"${compose[@]}" exec -T postgres pg_restore --list < "$backup/database.dump" > "$backup/database.contents"
"${compose[@]}" run --rm --no-deps --entrypoint tar app -C /data/uploads -czf - . > "$backup/uploads.tar.gz"
tar -tzf "$backup/uploads.tar.gz" > "$backup/uploads.contents"
"${compose[@]}" run --rm migrate 2>&1 | tee "$backup/migration.log"
"${compose[@]}" up -d --wait
"${compose[@]}" ps > "$backup/services.txt"
printf '%s\n' "$target" > "$backup/revision.txt"
printf '%s\n' "$tag" > "$root/.release-backups/current-version"
echo "Deployed $tag ($target). Backup and evidence: $backup"
echo 'Use this same APP_VERSION on subsequent Compose commands. Verify login and existing user data now.'
