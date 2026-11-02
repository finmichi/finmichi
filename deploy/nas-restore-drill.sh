#!/bin/sh
# Always restore into a dedicated temporary DB, never the live finmichi DB.
set -eu
umask 077
[ "$#" -eq 1 ] && [ -f "$1" ] || { echo 'Usage: nas-restore-drill.sh <dump>' >&2; exit 1; }
CONTAINER=${POSTGRES_CONTAINER:-finmichi-postgres-1}
created=false
cleanup() {
  if [ "$created" = true ]; then
    if ! docker exec "$CONTAINER" dropdb -U finmichi --force finmichi_drill >/dev/null 2>&1; then
      echo 'Drill cleanup failed: remove finmichi_drill manually before retrying' >&2
      exit 1
    fi
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
if ! docker exec -i "$CONTAINER" pg_restore --list < "$1" >/dev/null 2>&1; then
  echo 'Drill failed: invalid archive' >&2; exit 1
fi
# createdb is the concurrency guard. If it already exists, do not drop or overwrite it.
if ! docker exec "$CONTAINER" createdb -U finmichi --template template0 finmichi_drill >/dev/null 2>&1; then
  echo 'Drill database unavailable or already exists; no database was changed' >&2; exit 1
fi
created=true
if ! docker exec -i "$CONTAINER" pg_restore -U finmichi -d finmichi_drill --exit-on-error --single-transaction --no-owner --no-privileges < "$1" >/dev/null 2>&1; then
  echo 'Drill failed: restore rejected' >&2; exit 1
fi
# Only schema version and counts are printed, never records or archive contents.
docker exec "$CONTAINER" psql -X -U finmichi -d finmichi_drill -v ON_ERROR_STOP=1 -Atc "SELECT 'schema_version=' || coalesce(max(name),'none') FROM schema_migrations; SELECT 'ledgers=' || count(*) FROM ledgers; SELECT 'transactions=' || count(*) FROM transactions;"
