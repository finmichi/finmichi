// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { itemService, ledgerService } from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>;
let parent: string, child: string;
const body = (name: string) => ({ name, kind: 'asset', currency: 'TWD' });
const path = () => `/api/ledgers/${f.ledger}/items`;
beforeAll(async () => {
  f = await fixture('items');
});
afterAll(async () => {
  if (f) await f.close();
});
it('creates parent and child with defaults and mutable flags', async () => {
  const p = await f.app.inject({
    method: 'POST',
    url: path(),
    headers: f.headers,
    payload: body('Synthetic parent'),
  });
  expect(p.statusCode).toBe(201);
  parent = String(p.json().id);
  const c = await f.app.inject({
    method: 'POST',
    url: path(),
    headers: f.headers,
    payload: {
      ...body('Synthetic child'),
      parent_id: parent,
      fixed: true,
      loan: true,
    },
  });
  expect(c.statusCode).toBe(201);
  child = String(c.json().id);
  expect(c.json()).toMatchObject({
    parent_id: parent,
    archived: false,
    fixed: true,
    loan: true,
    credit_card: false,
  });
});
it('renames without resetting omitted parent/flags and moves to root with explicit null', async () => {
  const r = await f.app.inject({
    method: 'PATCH',
    url: path() + '/' + child,
    headers: f.headers,
    payload: { name: 'Synthetic renamed' },
  });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({
    name: 'Synthetic renamed',
    parent_id: parent,
    fixed: true,
    loan: true,
  });
  const moved = await f.app.inject({
    method: 'PATCH',
    url: path() + '/' + child,
    headers: f.headers,
    payload: { parent_id: null },
  });
  expect(moved.statusCode).toBe(200);
  expect(moved.json().parent_id).toBeNull();
  await itemService(f.db).update(f.actor, f.ledger, child, {
    parent_id: parent,
  });
});
it('rejects self/descendant cycles and foreign-ledger parents', async () => {
  for (const id of [parent, child]) {
    const r = await f.app.inject({
      method: 'PATCH',
      url: path() + '/' + parent,
      headers: f.headers,
      payload: { parent_id: id },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid_input' });
  }
  const other = await ledgerService(f.db).create(f.actor, {
    name: 'Synthetic other items ledger',
  });
  const foreign = await itemService(f.db).create(
    f.actor,
    other.id,
    body('Synthetic foreign'),
  );
  const r = await f.app.inject({
    method: 'PATCH',
    url: path() + '/' + child,
    headers: f.headers,
    payload: { parent_id: foreign.id },
  });
  expect(r.statusCode).toBe(404);
});
it('rejects immutable/unknown fields, empty patches and malformed queries', async () => {
  for (const payload of [
    { kind: 'expense' },
    { currency: 'USD' },
    { ledger_id: f.ledger },
    {},
    { archived: 'true' },
    { name: ' ' },
  ]) {
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: path() + '/' + child,
          headers: f.headers,
          payload,
        })
      ).statusCode,
    ).toBe(400);
  }
  expect(
    (
      await f.app.inject({
        url: path() + '?include_archived=1',
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await f.app.inject({ url: path() + '?surprise=true', headers: f.headers }))
      .statusCode,
  ).toBe(400);
});
it('isolates core and every HTTP operation by ledger owner', async () => {
  expect((await f.app.inject(path())).statusCode).toBe(401);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: path(),
        headers: { ...f.headers, origin: 'https://evil.invalid' },
        payload: body('Denied'),
      })
    ).statusCode,
  ).toBe(403);
  for (const method of ['GET', 'POST', 'PATCH'] as const) {
    const r = await f.app.inject({
      method,
      url: method === 'PATCH' ? path() + '/' + child : path(),
      headers: f.otherHeaders,
      ...(method === 'GET'
        ? {}
        : { payload: method === 'POST' ? body('Denied') : { name: 'Denied' } }),
    });
    expect(r.statusCode).toBe(404);
  }
  const [u] =
    await f.db`SELECT id FROM users WHERE oidc_issuer='https://items.synthetic.invalid' AND oidc_subject='stranger'`;
  await expect(
    itemService(f.db).update(String(u!.id), f.ledger, child, {
      archived: true,
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
});
it('enforces case-insensitive names per kind but permits the same name in another kind', async () => {
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: path(),
        headers: f.headers,
        payload: body('synthetic PARENT'),
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: path(),
        headers: f.headers,
        payload: { ...body('Synthetic parent'), kind: 'expense' },
      })
    ).statusCode,
  ).toBe(201);
});
it('archives only selected item, retains history/children and can restore it', async () => {
  await f.db.begin(async (sql) => {
    const [tx] =
      await sql`INSERT INTO transactions(ledger_id,occurred_on,kind) VALUES (${f.ledger},'2026-01-01','transfer') RETURNING id`;
    await sql`INSERT INTO transaction_entries(ledger_id,transaction_id,item_id,amount,currency,exchange_rate,base_amount) VALUES (${f.ledger},${tx!.id},${parent},'-1','TWD','1','-1'),(${f.ledger},${tx!.id},${child},'1','TWD','1','1')`;
  });
  const r = await f.app.inject({
    method: 'PATCH',
    url: path() + '/' + parent,
    headers: f.headers,
    payload: { archived: true },
  });
  expect(r.statusCode).toBe(200);
  const active = (
    await f.app.inject({ url: path(), headers: f.headers })
  ).json() as { id: string }[];
  expect(active.map((r) => r.id)).not.toContain(parent);
  expect(active.map((r) => r.id)).toContain(child);
  const all = await itemService(f.db).list(f.actor, f.ledger, {
    include_archived: 'true',
  });
  expect(all.find((r) => r.id === parent)?.archived).toBe(true);
  expect(
    await f.db`SELECT id FROM transaction_entries WHERE item_id=${parent}`,
  ).toHaveLength(1);
  expect(
    (await itemService(f.db).get(f.actor, f.ledger, child)).parent_id,
  ).toBe(parent);
  expect(
    (
      await itemService(f.db).update(f.actor, f.ledger, parent, {
        archived: false,
      })
    ).archived,
  ).toBe(false);
});
it('serializes opposite concurrent moves and rejects the one that would create a cycle', async () => {
  const a = await itemService(f.db).create(
    f.actor,
    f.ledger,
    body('Synthetic concurrent A'),
  );
  const b = await itemService(f.db).create(
    f.actor,
    f.ledger,
    body('Synthetic concurrent B'),
  );
  const responses = await Promise.all(
    [
      [a.id, b.id],
      [b.id, a.id],
    ].map(([id, parent_id]) =>
      f.app.inject({
        method: 'PATCH',
        url: path() + '/' + id,
        headers: f.headers,
        payload: { parent_id },
      }),
    ),
  );
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  const rows = await itemService(f.db).list(f.actor, f.ledger);
  expect(
    rows.filter((r) => [a.id, b.id].includes(r.id) && r.parent_id !== null),
  ).toHaveLength(1);
  expect(
    await f.db`SELECT action FROM audit_logs WHERE user_id=${f.actor} AND action='item.update' AND outcome='error'`,
  ).not.toHaveLength(0);
});
