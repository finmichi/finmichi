#!/bin/sh
set -eu
# A container must bind the source file itself read-only, not merely promise not to write it.
awk '$5 == "/data/source.mdb" && $6 ~ /(^|,)ro(,|$)/ {found=1} END {exit !found}' /proc/self/mountinfo || {
  echo 'source_mount_must_be_read_only' >&2
  exit 1
}
exec /usr/local/lib/life-mdb-export.sh "${1:-export}" /data/source.mdb /output
