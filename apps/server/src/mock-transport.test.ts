// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mockTransport } from './mock-transport.js';
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += String(chunk);
  });
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ host: request.headers.host, path: request.url, body }),
    );
  });
});
let internal: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing socket');
  internal = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
it('preserves external Host/issuer and form body across Docker transport', async () => {
  const fetch = mockTransport('http://localhost:8081/default', internal);
  const response = await fetch('http://localhost:8081/default/token', {
    method: 'POST',
    headers: new Headers(),
    redirect: 'manual',
    body: new URLSearchParams({ code_verifier: 'synthetic' }),
  });
  expect(await response.json()).toEqual({
    host: 'localhost:8081',
    path: '/default/token',
    body: 'code_verifier=synthetic',
  });
  await expect(
    fetch('http://unexpected.invalid/default', {
      method: 'GET',
      headers: new Headers(),
      redirect: 'manual',
      body: undefined,
    }),
  ).rejects.toThrow('Unexpected OIDC origin');
});
