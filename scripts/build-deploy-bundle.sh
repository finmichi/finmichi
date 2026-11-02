#!/bin/sh
# Build only allowlisted deployment files; never glob the deploy directory.
# Runs on the Linux build host. The extracted files need no git/Node installation.
set -eu
[ "$#" -eq 2 ] || { echo 'Usage: build-deploy-bundle.sh VERSION OUTPUT_DIRECTORY' >&2; exit 1; }
version=$1
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' || {
  echo 'Invalid bundle version' >&2; exit 1;
}
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$2"
out=$(CDPATH='' cd -- "$2" && pwd)
stage=$(mktemp -d "$out/.deploy-bundle.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$stage/files"
set -- ssh/compose.nas.yaml ssh/.env.nas.example nas-backup.sh nas-restore-drill.sh ssh/RUNBOOK-nas.md docker-compose.yaml .env.example README.md
[ ! -L "$repo/deploy/container-manager" ] || { echo "Unsafe source directory" >&2; exit 1; }
for file do
  case "$file" in
    ssh/*) relative=${file#ssh/} ;;
    docker-compose.yaml) relative=container-manager/compose.yaml ;;
    .env.example|README.md) relative=container-manager/$file ;;
    *) relative=$file ;;
  esac
  source="$repo/deploy/$relative"
  [ -f "$source" ] && [ ! -L "$source" ] || { echo "Missing or unsafe bundle file: $file" >&2; exit 1; }
  mkdir -p "$stage/files/$(dirname "$file")"
  cp "$source" "$stage/files/$file"
  chmod 644 "$stage/files/$file"
done
chmod 755 "$stage/files/nas-backup.sh" "$stage/files/nas-restore-drill.sh"
# Hash source bytes independently of tar/gzip/zip tool versions.
(cd "$stage/files" && sha256sum "$@" > SHA256SUMS)
cp "$stage/files/SHA256SUMS" "$out/finmichi-deploy-$version.files.sha256"
(cd "$stage/files" && sha256sum SHA256SUMS) >> "$out/finmichi-deploy-$version.files.sha256"
set -- "$@" SHA256SUMS
# Reproducibility is limited to identical build tools/runner versions.
tar --format=ustar --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$stage/files" -cf "$stage/bundle.tar" -- "$@"
name="finmichi-deploy-$version.tar.gz"
gzip -n -c "$stage/bundle.tar" > "$stage/$name"
(cd "$stage" && sha256sum "$name" > "$name.sha256")
mv "$stage/$name" "$out/$name"
mv "$stage/$name.sha256" "$out/$name.sha256"
zipname="finmichi-deploy-$version.zip"
python3 - "$stage/files" "$stage/$zipname" "$@" <<'PYZIP'
import sys, stat, zipfile
from pathlib import Path
root = Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in sys.argv[3:]:
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | (0o755 if name.endswith('.sh') else 0o644)) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, (root / name).read_bytes())
PYZIP
(cd "$stage" && sha256sum "$zipname" > "$zipname.sha256")
mv "$stage/$zipname" "$out/$zipname"
mv "$stage/$zipname.sha256" "$out/$zipname.sha256"
printf '%s\n' "$out/$name" "$out/$name.sha256" "$out/$zipname" "$out/$zipname.sha256" "$out/finmichi-deploy-$version.files.sha256"
