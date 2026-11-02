// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic smoke only: no production config or credentials.
import { createServer } from 'node:https';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
createServer(
  { key: readFileSync('/test/tls-key'), cert: readFileSync('/test/tls-cert') },
  (req, res) => {
    const upstream = request(
      {
        hostname: 'app',
        port: 8080,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          'x-forwarded-for': req.socket.remoteAddress,
          'x-forwarded-proto': 'https',
        },
      },
      (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  },
).listen(8443, '0.0.0.0');
