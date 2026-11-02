#!/bin/sh
# Export an already built/scanned image, without registry access or rebuilding.
set -eu
[ "$#" -eq 3 ] || { echo 'Usage: export-image-asset.sh PACKAGE TAG OUT_DIR' >&2; exit 1; }
package=$1 tag=$2
case "$package" in finmichi|finmichi-worker|finmichi-postgres) ;; *) echo 'Unknown package' >&2; exit 1;; esac
printf '%s\n' "$tag" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' || { echo 'Invalid tag' >&2; exit 1; }
ref="ghcr.io/finmichi/$package:$tag"
[ "$(docker image inspect "$ref" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64 ] || { echo 'Expected linux/amd64' >&2; exit 1; }
mkdir -p "$3"
out=$(CDPATH='' cd -- "$3" && pwd)
stage=$(mktemp -d "$out/.image-export.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
name="finmichi-image-$package-$tag.tar"
docker save "$ref" -o "$stage/$name"
# Docker's image inspect Id can be a manifest digest with the containerd store.
# Hash the actual config JSON inside docker save, not the registry manifest.
python3 - "$stage/$name" "$ref" <<'PY'
import hashlib, json, sys, tarfile
from pathlib import Path
p=Path(sys.argv[1]); ref=sys.argv[2]
with tarfile.open(p) as t:
    entries=json.load(t.extractfile('manifest.json'))
    assert len(entries)==1 and entries[0]['RepoTags']==[ref], 'unexpected saved tags'
    raw=t.extractfile(entries[0]['Config']).read()
    config=json.loads(raw)
    assert config['os']=='linux' and config['architecture']=='amd64'
    image_id='sha256:'+hashlib.sha256(raw).hexdigest()
with p.open('rb') as f: sha=hashlib.file_digest(f, 'sha256').hexdigest()
p.with_suffix('.tar.sha256').write_text(sha+'  '+p.name+'\n')
p.with_suffix('.tar.json').write_text(json.dumps({'file':p.name,'sha256':sha,'ref':ref,'image_id':image_id,'platform':'linux/amd64','diff_ids':config['rootfs']['diff_ids']},indent=2)+'\n')
PY
mv "$stage/$name" "$stage/$name.sha256" "$stage/$name.json" "$out/"
printf '%s\n' "$out/$name" "$out/$name.sha256" "$out/$name.json"
