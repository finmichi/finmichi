// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ledgerService } from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture('ledgers');
});
afterAll(async () => {
  if (f) await f.close();
});
it('requires a real DB session, rejects cross-site writes and malformed IDs', async () => {
  expect((await f.app.inject('/api/ledgers')).statusCode).toBe(401);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/ledgers',
        headers: { ...f.headers, origin: 'https://evil.invalid' },
        payload: { name: 'denied' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await f.app.inject({ url: '/api/ledgers/not-a-uuid', headers: f.headers }))
      .statusCode,
  ).toBe(400);
});
it('isolates all ledger reads/writes by owner and also enforces ownership in core', async () => {
  const list = await f.app.inject({
    url: '/api/ledgers',
    headers: f.otherHeaders,
  });
  expect(list.json()).toEqual([]);
  for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
    const r = await f.app.inject({
      method,
      url: `/api/ledgers/${f.ledger}`,
      headers: f.otherHeaders,
      ...(method === 'PATCH' ? { payload: { name: 'stolen' } } : {}),
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
  }
  const [other] =
    await f.db`SELECT id FROM users WHERE oidc_issuer='https://ledgers.synthetic.invalid' AND oidc_subject='stranger'`;
  await expect(
    ledgerService(f.db).update(String(other!.id), f.ledger, { name: 'bypass' }),
  ).rejects.toMatchObject({ statusCode: 404 });
});
it('strictly validates mutation fields without owner or lock escalation', async () => {
  for (const payload of [
    { name: ' ', base_currency: 'TWD' },
    { name: 'x', base_currency: 'twd' },
    { name: 'x', owner_id: f.actor },
    { name: 'x', locked_until: '2099-01-01' },
  ]) {
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/ledgers',
          headers: f.headers,
          payload,
        })
      ).statusCode,
    ).toBe(400);
  }
  expect(
    (
      await f.app.inject({
        method: 'PATCH',
        url: `/api/ledgers/${f.ledger}`,
        headers: f.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(400);
});
it('creates, reads, renames, changes empty-ledger currency and deletes; audits contain no names', async () => {
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/ledgers',
    headers: f.headers,
    payload: { name: '  Synthetic editable  ' },
  });
  expect(created.statusCode).toBe(201);
  const id = String(created.json().id);
  expect(created.json()).toMatchObject({
    name: 'Synthetic editable',
    base_currency: 'TWD',
    locked_until: null,
  });
  const renamed = await f.app.inject({
    method: 'PATCH',
    url: `/api/ledgers/${id}`,
    headers: f.headers,
    payload: { name: 'Synthetic renamed', base_currency: 'USD' },
  });
  expect(renamed.statusCode).toBe(200);
  expect(renamed.json()).toMatchObject({
    name: 'Synthetic renamed',
    base_currency: 'USD',
  });
  expect(
    (
      await f.app.inject({ url: `/api/ledgers/${id}`, headers: f.headers })
    ).json(),
  ).toEqual(renamed.json());
  const duplicate = await f.app.inject({
    method: 'POST',
    url: '/api/ledgers',
    headers: f.headers,
    payload: { name: 'synthetic RENAMED' },
  });
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json()).toEqual({ error: 'duplicate_name' });
  expect(
    (
      await f.app.inject({
        method: 'DELETE',
        url: `/api/ledgers/${id}`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (await f.app.inject({ url: `/api/ledgers/${id}`, headers: f.headers }))
      .statusCode,
  ).toBe(404);
  const audit =
    await f.db`SELECT action,outcome FROM audit_logs WHERE user_id=${f.actor} AND action LIKE 'ledger.%'`;
  expect(audit).toContainEqual({ action: 'ledger.delete', outcome: 'success' });
  expect(JSON.stringify(audit)).not.toContain('Synthetic');
});
it.each([
  'items',
  'payees',
  'projects',
  'memo_templates',
  'exchange_rates',
  'import_jobs',
] as const)(
  'protects nonempty ledger with %s against cascade delete or base-currency change',
  async (table) => {
    const l = await ledgerService(f.db).create(f.actor, {
      name: `Synthetic populated ${table}`,
    });
    if (table === 'items')
      await f.db`INSERT INTO items(ledger_id,kind,name,currency) VALUES (${l.id},'asset','Synthetic','TWD')`;
    else if (table === 'exchange_rates')
      await f.db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES (${l.id},'2026-01-01','USD','TWD','32')`;
    else if (table === 'import_jobs')
      await f.db`INSERT INTO import_jobs(ledger_id,source_sha256,source_system,status) VALUES (${l.id},${'a'.repeat(64)},'synthetic','validated')`;
    else if (table === 'memo_templates')
      await f.db`INSERT INTO memo_templates(ledger_id,name,memo) VALUES (${l.id},'Synthetic','Synthetic memo')`;
    else
      await f.db`INSERT INTO ${f.db(table)}(ledger_id,name) VALUES (${l.id},'Synthetic')`;
    for (const method of ['DELETE', 'PATCH'] as const) {
      const r = await f.app.inject({
        method,
        url: `/api/ledgers/${l.id}`,
        headers: f.headers,
        ...(method === 'PATCH' ? { payload: { base_currency: 'USD' } } : {}),
      });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'ledger_not_empty' });
    }
    expect((await ledgerService(f.db).get(f.actor, l.id)).base_currency).toBe(
      'TWD',
    );
  },
);
it('serializes empty-ledger delete against a concurrent child insert', async () => {
  const l = await ledgerService(f.db).create(f.actor, {
    name: 'Synthetic concurrency',
  });
  let release!: () => void, locked!: () => void;
  const signal = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = f.db.begin(async (sql) => {
    await sql`INSERT INTO payees(ledger_id,name) VALUES (${l.id},'Synthetic concurrent child')`;
    locked();
    await barrier;
  });
  await signal;
  const removing = ledgerService(f.db).remove(f.actor, l.id);
  release();
  await writer;
  await expect(removing).rejects.toMatchObject({ code: 'ledger_not_empty' });
  expect(
    await f.db`SELECT id FROM payees WHERE ledger_id=${l.id}`,
  ).toHaveLength(1);
});
