#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -e .env || -e local ]]; then
  # Separate inodes retain private :Z labels for app and worker on SELinux hosts.
  if [[ -f local/database-url && ! -e local/worker-database-url ]]; then
    cp local/database-url local/worker-database-url
    chmod 444 local/worker-database-url
  fi
  echo 'Existing dev configuration: reuse it; no files overwritten.'
  exit 0
fi
umask 077
mkdir local
openssl rand -hex 32 > local/postgres-password
printf 'postgresql://finmichi:%s@postgres:5432/finmichi' "$(cat local/postgres-password)" > local/database-url
cp local/database-url local/worker-database-url
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 30 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout local/tls-key -out local/tls-cert 2>/dev/null
# DEV ONLY: private host directory; nonroot dev containers need individual mount read access.
# Never reuse these files or permissions in staging/production (see RUNBOOK).
chmod 444 local/postgres-password local/database-url local/worker-database-url local/tls-key local/tls-cert
cat > .env <<'ENV'
PUBLIC_URL=https://localhost:8443
OIDC_ISSUER=http://localhost:8081/default
OIDC_CLIENT_ID=finmichi-dev
ALLOWED_SUBJECTS=synthetic-allowed
TRUST_PROXY=0
APP_VERSION=0.0.1
ENV
echo 'DEV ONLY: local synthetic configuration generated; never copy these files to production.'
