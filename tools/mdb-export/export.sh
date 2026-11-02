#!/bin/sh
set -eu
umask 077
mode=${1:-export}
source=${2:-/data/source.mdb}
output=${3:-/output}
case "$mode" in export|inventory) ;; *) echo 'invalid_command' >&2; exit 1;; esac
[ -f "$source" ] || { echo 'source_not_found' >&2; exit 1; }
sha=$(sha256sum "$source" | cut -d' ' -f1)
# Stage every artifact together; an incomplete directory can never be consumed as an export.
mkdir -p "$output"
[ ! -e "$output/$sha" ] || { echo 'export_already_exists' >&2; exit 1; }
stage=$(mktemp -d "$output/.tmp.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mdb-tables -1 "$source" > "$stage/tables.tmp"
[ -s "$stage/tables.tmp" ] || { echo 'no_tables' >&2; exit 1; }
printf 'SOURCE_SHA256|%s\n' "$sha" > "$stage/manifest.txt.tmp"
# Preserve the source file date, never substitute the export date for historical rates.
printf 'SOURCE_DATE|%s\n' "$(TZ=CST-8 date -r "$source" +%Y-%m-%d)" >> "$stage/manifest.txt.tmp"
printf 'EXPORTED_AT|%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$stage/manifest.txt.tmp"
while IFS= read -r table; do
  case "$table" in ''|*[!A-Za-z0-9_]*|[0-9_]*) echo 'unsupported_table_name' >&2; exit 1;; esac
  lower=$(printf '%s' "$table" | tr 'A-Z' 'a-z')
  [ ! -e "$stage/$lower.csv" ] || { echo 'duplicate_table_name' >&2; exit 1; }
  rows=$(mdb-count "$source" "$table")
  case "$rows" in ''|*[!0-9]*) echo 'invalid_row_count' >&2; exit 1;; esac
  mdb-export -D '%Y/%m/%d' -T '%Y/%m/%d' "$source" "$table" > "$stage/$lower.csv.tmp"
  mv "$stage/$lower.csv.tmp" "$stage/$lower.csv"
  file_sha=$(sha256sum "$stage/$lower.csv" | cut -d' ' -f1)
  printf '%s|%s|%s\n' "$table" "$rows" "$file_sha" >> "$stage/manifest.txt.tmp"
done < "$stage/tables.tmp"
if [ "$mode" = inventory ]; then
  mdb-schema "$source" postgres > "$stage/schema.sql.tmp"
  mv "$stage/schema.sql.tmp" "$stage/schema.sql"
fi
rm "$stage/tables.tmp"
mv "$stage/manifest.txt.tmp" "$stage/manifest.txt"
# Serialize publication even if two exporters target the same hash concurrently.
lock="$output/.$sha.lock"
mkdir "$lock" || { echo 'export_in_progress' >&2; exit 1; }
trap 'rm -rf "$stage"; rmdir "$lock"' EXIT HUP INT TERM
[ ! -e "$output/$sha" ] || { echo 'export_already_exists' >&2; exit 1; }
mv -T "$stage" "$output/$sha"
printf 'export_complete %s\n' "$sha"
