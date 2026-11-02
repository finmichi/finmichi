#!/bin/sh
set -eu
command -v shellcheck >/dev/null 2>&1 || { echo "ShellCheck is required for actionlint parity with CI" >&2; exit 1; }
# Pinned upstream release and checksum; no code fetched from a mutable branch.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --retry 3 \
  https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \
  -o "$work/actionlint.tar.gz"
printf '%s  %s\n' 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 "$work/actionlint.tar.gz" | sha256sum -c -
tar -xzf "$work/actionlint.tar.gz" -C "$work" actionlint
"$work/actionlint" -color
