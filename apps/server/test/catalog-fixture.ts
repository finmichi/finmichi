// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { once } from 'node:events';
import { connect, migrate } from '@finmichi/db';
import { sessionService } from '@finmichi/core';
import { createApp } from '../src/app.js';
export async function fixture(
  topic: string,
  options: { allowFactoryReset?: boolean } = {},
) {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error('TEST_DATABASE_URL required');
  const db = connect(process.env.TEST_DATABASE_URL);
  await migrate(db);
  const issuer = `https://${topic}.synthetic.invalid`;
  const discovery = createServer((_req, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }),
    );
  });
  discovery.listen(0, '127.0.0.1');
  await once(discovery, 'listening');
  const address = discovery.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing discovery listener');
  const sessions = sessionService(db, ['owner', 'stranger']);
  const token = await sessions.login(issuer, 'owner'),
    otherToken = await sessions.login(issuer, 'stranger');
  const actor = (await sessions.authenticate(token!))!.id;
  const app = await createApp(
    {
      databaseUrl: process.env.TEST_DATABASE_URL,
      publicUrl: 'https://ledger.synthetic.invalid',
      issuer,
      clientId: 'synthetic',
      allowedSubjects: ['owner', 'stranger'],
      trustProxy: 0,
      version: 'test',
      mockInternalUrl: `http://127.0.0.1:${address.port}`,
      ...options,
    },
    db,
  );
  await app.ready();
  const headers = {
    cookie: `session=${token}`,
    origin: 'https://ledger.synthetic.invalid',
  };
  const otherHeaders = { ...headers, cookie: `session=${otherToken}` };
  const created = await app.inject({
    method: 'POST',
    url: '/api/ledgers',
    headers,
    payload: { name: `${topic} synthetic`, base_currency: 'TWD' },
  });
  if (created.statusCode !== 201) throw new Error('Fixture ledger failed');
  const ledger = String(created.json().id);
  return {
    db,
    app,
    actor,
    headers,
    otherHeaders,
    ledger,
    async close() {
      await app.close();
      discovery.close();
      await once(discovery, 'close');
      await db.end();
    },
  };
}
