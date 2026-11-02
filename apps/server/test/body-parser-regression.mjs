// SPDX-License-Identifier: AGPL-3.0-only
// Isolated dependency regression: never let an uncaught decoder error kill Vitest.
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { gzipSync, deflateSync } from 'node:zlib';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const sdk = createRequire(import.meta.url).resolve(
  '@modelcontextprotocol/sdk/server/streamableHttp.js',
);
const express = createRequire(sdk).resolve('express');
const parser = createRequire(express)(
  process.env.BODY_PARSER_TEST_PATH || 'body-parser',
);
const mode = process.argv[2];
const payload = Buffer.from('{"synthetic":true}');
const encoding = mode.startsWith('gzip')
  ? 'gzip'
  : mode.startsWith('deflate')
    ? 'deflate'
    : 'identity';
const frame =
  encoding === 'gzip'
    ? gzipSync(payload)
    : encoding === 'deflate'
      ? deflateSync(payload)
      : payload;
const tail = mode.endsWith('trailing')
  ? Buffer.concat([Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)])
  : Buffer.alloc(0);
const server = createServer((req, res) =>
  parser.json()(req, res, (err) => {
    if (err) {
      res.statusCode = err.status || 500;
      res.end('rejected');
      return;
    }
    assert.deepEqual(req.body, { synthetic: true });
    res.end('accepted');
  }),
);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const socket = connect(server.address().port, '127.0.0.1');
await once(socket, 'connect');
let reply = '';
const responseFinished = new Promise((resolve) => socket.once('end', resolve));
socket.on('data', (chunk) => {
  reply += chunk.toString();
});
socket.on('error', () => {});
const timeout = setTimeout(() => process.exit(2), 3000);
socket.write(
  `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Encoding: ${encoding}\r\nContent-Length: ${frame.length + tail.length}\r\nConnection: close\r\n\r\n`,
);
if (encoding === 'gzip' && tail.length)
  socket.write(Buffer.concat([frame, tail]));
else {
  socket.write(frame);
  if (tail.length) {
    await new Promise((r) => setTimeout(r, 30));
    socket.write(tail);
  }
}
await responseFinished;
// Keep observing after response completion for asynchronous decoder errors.
await new Promise((r) => setTimeout(r, 150));
assert.match(reply, /HTTP\/1\.1 (200|400)/);
if (!tail.length) assert.match(reply, /accepted/);
socket.destroy();
server.closeAllConnections();
await new Promise((r) => server.close(r));
clearTimeout(timeout);
console.log(mode + ' survived');
