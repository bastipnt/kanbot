#!/usr/bin/env bash
# Runs on the deploy host, piped over SSH by .github/workflows/deploy.yml.
# Requires DEPLOY_PATH and IMAGE_TAG. Backs up Postgres, rolls out IMAGE_TAG and
# rolls back to the previously deployed tag if the stack doesn't become healthy.
#
# Note: the rollback restores the old image only. If the failed release already
# applied a migration the old server can't handle, restore the pre-deploy backup.
set -euo pipefail

cd "$DEPLOY_PATH"

compose() {
  docker compose -f docker-compose.prod.yml --env-file .env.production "$@"
}

previous_tag=$(cat .deployed-tag 2>/dev/null || true)
echo "Deploying ${IMAGE_TAG} (previous: ${previous_tag:-none})"

export IMAGE_TAG
compose pull

# Migrations run when the new server starts, so snapshot the database first.
if [ -n "$(compose ps -q db)" ]; then
  mkdir -p backups
  backup="backups/pre-${IMAGE_TAG}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  # This script arrives on stdin (ssh ... bash -s): without </dev/null, exec
  # swallows the rest of it and bash exits 0 right after the backup.
  # shellcheck disable=SC2016 # expands inside the postgres container
  compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' < /dev/null | gzip > "$backup"
  chmod 600 "$backup"
  echo "Backup written to ${backup}"
  # Keep the 10 most recent backups.
  # shellcheck disable=SC2012 # we control these filenames
  ls -1t backups/pre-*.sql.gz | tail -n +11 | xargs -r rm --
fi

if compose up -d --remove-orphans --wait --wait-timeout 180; then
  echo "$IMAGE_TAG" > .deployed-tag
  docker image prune -f
  echo "Deployed ${IMAGE_TAG}"
  exit 0
fi

echo "Deploy of ${IMAGE_TAG} failed" >&2
compose logs --tail 100 server >&2 || true

if [ -n "$previous_tag" ]; then
  echo "Rolling back to ${previous_tag}" >&2
  IMAGE_TAG="$previous_tag" compose up -d --remove-orphans --wait --wait-timeout 180
fi
exit 1
