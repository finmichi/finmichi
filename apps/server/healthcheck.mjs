// SPDX-License-Identifier: AGPL-3.0-only
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
const tls = Boolean(process.env.TLS_KEY_FILE && process.env.TLS_CERT_FILE);
const client = tls ? https : http;
const request = client.get(
  {
    hostname: '127.0.0.1',
    port: Number(process.env.PORT ?? 8080),
    path: '/api/health',
    timeout: 4000,
    ...(tls ? { ca: readFileSync(process.env.TLS_CERT_FILE) } : {}),
  },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);
request.on('timeout', () => request.destroy());
request.on('error', () => process.exit(1));
