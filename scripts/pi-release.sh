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
# Compare resolved configuration with the running deployment without printing secrets.
python3 - "$env_file" "$root/deploy/compose/docker-compose.yml" <<'PY'
import json, subprocess, sys
config = json.loads(subprocess.check_output(['docker','compose','--env-file',sys.argv[1],'-f',sys.argv[2],'config','--format','json']))
assert config['name'] == 'personal-portfolio', 'Unexpected Compose project'
for name in ['app', 'backend', 'postgres']:
    current = json.loads(subprocess.check_output(['docker','inspect','personal-portfolio-'+name]))[0]
    actual = dict(x.split('=',1) for x in current['Config']['Env'] if '=' in x)
    expected = config['services'][name]['environment']
    for key in ['DATABASE_URL','POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD','BETTER_AUTH_SECRET','INTERNAL_AUTH_SECRET','DATA_ENCRYPTION_KEY_CURRENT','DATA_ENCRYPTION_KEY_PREVIOUS','DATA_ENCRYPTION_KEY_ID','APP_URL']:
        if key in expected:
            assert str(expected[key] or '') == actual.get(key,''), f'{name}: {key} differs; review before deployment'
    for mount in config['services'][name].get('volumes', []):
        if mount['type'] == 'volume':
            volume = config['volumes'][mount['source']]['name']
            assert any(m.get('Name') == volume and m['Destination'] == mount['target'] for m in current['Mounts']), 'Volume identity differs'
print('Running configuration keys and persistent volumes match.')
PY
backup="$root/.release-backups/$(date -u +%Y%m%dT%H%M%SZ)-$tag"
mkdir -p "$backup"
cp "$env_file" "$backup/production.env"
"${compose[@]}" config > "$backup/resolved-compose.yaml"
"${compose[@]}" images --format json > "$backup/previous-images.json"
docker inspect personal-portfolio-app personal-portfolio-backend > "$backup/previous-containers.json"
# Pull application images only; infrastructure upgrades are a separate operation.
"${compose[@]}" pull app backend migrate worker beat mcp
for service in app backend; do
  image="ghcr.io/charlie-turner-314/personal-portfolio-${service/app/frontend}:$tag"
  revision="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  [[ "$revision" = "$target" ]] || { echo "Image revision mismatch for $service"; exit 1; }
  docker image inspect "$image" --format '{{json .RepoDigests}}' >> "$backup/release-digests.txt"
done
# Stop all writers before taking a consistent application backup.
"${compose[@]}" stop app backend worker beat mcp
trap 'echo "Release stopped. Backup: $backup. Inspect migration logs before restarting; do not delete volumes."' ERR
python3 "$root/scripts/db-evidence.py" > "$backup/data-before.json"
"${compose[@]}" exec -T postgres sh -c 'exec pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$backup/database.dump"
test -s "$backup/database.dump"
"${compose[@]}" exec -T postgres pg_restore --list < "$backup/database.dump" > "$backup/database.contents"
"${compose[@]}" run --rm --no-deps --entrypoint tar app -C /data/uploads -czf - . > "$backup/uploads.tar.gz"
tar -tzf "$backup/uploads.tar.gz" > "$backup/uploads.contents"
# Prove the dump restores into a separate, empty database before changing production.
rehearsal_db="release_restore_$(date -u +%Y%m%d%H%M%S)"
"${compose[@]}" exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$rehearsal_db"
"${compose[@]}" exec -T postgres sh -c 'pg_restore --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$1"' sh "$rehearsal_db" < "$backup/database.dump"
"${compose[@]}" exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" "$1"' sh "$rehearsal_db"
"${compose[@]}" run --rm migrate 2>&1 | tee "$backup/migration.log"
"${compose[@]}" run --rm migrate > "$backup/migration-repeat.log" 2>&1
python3 "$root/scripts/db-evidence.py" "$backup/data-before.json" > "$backup/data-after.json"
"${compose[@]}" up -d --wait
"${compose[@]}" ps > "$backup/services.txt"
printf '%s\n' "$target" > "$backup/revision.txt"
printf '%s\n' "$tag" > "$root/.release-backups/current-version"
echo "Deployed $tag ($target). Backup and evidence: $backup"
echo 'Use this same APP_VERSION on subsequent Compose commands. Verify login and existing user data now.'
