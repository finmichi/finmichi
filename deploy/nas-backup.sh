#!/bin/sh
# DSM Task Scheduler: run as root. Only the configured finmichi database is read.
# BACKUP_WAIT_SECONDS: maximum readiness wait (default 60; 0 = one probe).
set -eu
umask 077
export LC_ALL=C
error_code=dump_failed
err=''
tmp=''
lock=''
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$result" -ne 0 ]; then
    # Diagnostics stay private and are never printed: they can contain credentials.
    if [ -n "$err" ] && grep -Eqi 'No space left on device|Disk quota exceeded' "$err"; then
      error_code=disk_full
    fi
    printf 'backup_error=%s\n' "$error_code" >&2
  fi
  [ -z "$tmp" ] || rm -f "$tmp" 2>/dev/null
  [ -z "$err" ] || rm -f "$err" 2>/dev/null
  if [ -n "$lock" ]; then
    rm -f "$lock/names" 2>/dev/null
    rmdir "$lock" 2>/dev/null
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
fail() { error_code=$1; exit 1; }
command -v docker >/dev/null 2>&1 || {
  echo 'Backup failed: docker not found in PATH; set PATH=/usr/local/bin:$PATH in DSM Task Scheduler' >&2
  fail dump_failed
}
[ -n "${BACKUP_DIR:-}" ] || fail dir_not_writable
KEEP=${KEEP-30}
WAIT=${BACKUP_WAIT_SECONDS-60}
CONTAINER=${POSTGRES_CONTAINER:-finmichi-postgres-1}
case "$KEEP" in ''|*[!0-9]*|0) fail config_invalid;; esac
case "$WAIT" in ''|*[!0-9]*) fail config_invalid;; esac
[ "$KEEP" -gt 0 ] 2>/dev/null && [ "$KEEP" -le 2147483647 ] 2>/dev/null || fail config_invalid
# Bound integer parsing without evaluating caller input as shell arithmetic.
[ "$WAIT" -le 2147483647 ] 2>/dev/null || fail config_invalid
err=$(mktemp "${TMPDIR:-/tmp}/finmichi-backup-error.XXXXXX" 2>/dev/null) || fail dump_failed
running=$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>"$err") || fail container_not_running
[ "$running" = true ] || fail container_not_running
mkdir -p "$BACKUP_DIR" 2>"$err" || fail dir_not_writable
chmod 700 "$BACKUP_DIR" 2>"$err" || fail dir_not_writable
# Probe actual writes, not just permission bits (ACL/read-only mounts also matter).
probe=$(mktemp "$BACKUP_DIR/.finmichi-write.XXXXXX" 2>"$err") || fail dir_not_writable
rm -f "$probe" 2>"$err" || fail dir_not_writable
# Refuse overlapping jobs; never remove a lock owned by another invocation.
lock_path="$BACKUP_DIR/.finmichi-backup.lock"
if ! mkdir "$lock_path" 2>"$err"; then
  [ ! -d "$lock_path" ] || fail backup_locked
  fail dir_not_writable
fi
lock=$lock_path

# The initialization server accepts sockets only; TCP means the final server.
start=$(date +%s)
while ! docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -q -t 1 -U finmichi -d finmichi > /dev/null 2>"$err"; do
  now=$(date +%s)
  # Round the second-resolution deadline up; never expire before WAIT seconds.
  # WAIT=0 still means exactly one probe. Allow one clock tick plus probe/poll overhead.
  [ "$WAIT" -gt 0 ] && [ "$((now - start))" -le "$WAIT" ] || fail db_not_ready
  sleep 1
done
# Second-resolution names: wait instead of overwriting a previous valid dump.
while :; do
  name="finmichi-$(TZ=Asia/Taipei date +%Y%m%d-%H%M%S).dump"
  final="$BACKUP_DIR/$name"
  [ -e "$final" ] || [ -e "$final.tmp" ] || break
  sleep 1
done
tmp="$final.tmp"
# Capture shell redirection errors too (e.g. a full filesystem).
if ! (docker exec -e LC_ALL=C "$CONTAINER" pg_dump -U finmichi -d finmichi -Fc > "$tmp") 2>"$err"; then
  if grep -Eqi 'password authentication failed|no password supplied|authentication failed|no pg_hba.conf entry' "$err"; then
    fail db_auth_failed
  fi
  fail dump_failed
fi
chmod 600 "$tmp" 2>"$err" || fail dir_not_writable
if ! (docker exec -i "$CONTAINER" pg_restore --list < "$tmp") > /dev/null 2>"$err"; then
  fail dump_failed
fi
mv "$tmp" "$final" 2>"$err" || fail dump_failed
tmp=''
# Strict own filename pattern; unrelated files, directories and symlinks are untouched.
list="$lock/names"
{
  for file in "$BACKUP_DIR"/finmichi-*.dump; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    base=${file##*/}
    if printf '%s\n' "$base" | grep -Eq '^finmichi-[0-9]{8}-[0-9]{6}\.dump$'; then
      printf '%s\n' "$base"
    fi
  done | LC_ALL=C sort -r > "$list"
} 2>"$err"
n=0
while IFS= read -r base; do
  n=$((n + 1))
  if [ "$n" -gt "$KEEP" ]; then rm -- "$BACKUP_DIR/$base" 2>"$err"; fi
done < "$list"
rm "$list" 2>"$err"
retained=$n
[ "$retained" -le "$KEEP" ] || retained=$KEEP
size=$(wc -c < "$final" | tr -d ' ')
printf 'file=%s bytes=%s retained=%s\n' "$name" "$size" "$retained"
