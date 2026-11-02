// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { itemService } from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>;
let asset: string, expense: string;
beforeAll(async () => {
  f = await fixture('item-kind');
  const service = itemService(f.db);
  asset = (
    await service.create(f.actor, f.ledger, {
      name: 'Synthetic asset parent',
      kind: 'asset',
      currency: 'TWD',
    })
  ).id;
  expense = (
    await service.create(f.actor, f.ledger, {
      name: 'Synthetic expense parent',
      kind: 'expense',
      currency: 'TWD',
    })
  ).id;
});
afterAll(async () => {
  if (f) await f.close();
});
it('HTTP create rejects a different kind with 400 and accepts same kind across currencies', async () => {
  const url = `/api/ledgers/${f.ledger}/items`;
  const denied = await f.app.inject({
    method: 'POST',
    url,
    headers: f.headers,
    payload: {
      name: 'Synthetic rejected child',
      kind: 'expense',
      currency: 'USD',
      parent_id: asset,
    },
  });
  expect(denied.statusCode).toBe(400);
  expect(denied.json()).toEqual({ error: 'parent_kind_mismatch' });
  const allowed = await f.app.inject({
    method: 'POST',
    url,
    headers: f.headers,
    payload: {
      name: 'Synthetic accepted child',
      kind: 'asset',
      currency: 'USD',
      parent_id: asset,
    },
  });
  expect(allowed.statusCode).toBe(201);
  expect(allowed.json()).toMatchObject({
    parent_id: asset,
    currency: 'USD',
    kind: 'asset',
  });
  expect(
    await f.db`SELECT id FROM items WHERE ledger_id=${f.ledger} AND name='Synthetic rejected child'`,
  ).toHaveLength(0);
});
it('HTTP move rejects a different kind, rolls back other fields and allows same kind or root', async () => {
  const service = itemService(f.db),
    row = await service.create(f.actor, f.ledger, {
      name: 'Synthetic HTTP move',
      kind: 'expense',
      currency: 'EUR',
    });
  const url = `/api/ledgers/${f.ledger}/items/${row.id}`;
  const denied = await f.app.inject({
    method: 'PATCH',
    url,
    headers: f.headers,
    payload: { parent_id: asset, name: 'Must roll back' },
  });
  expect(denied.statusCode).toBe(400);
  expect(denied.json()).toEqual({ error: 'parent_kind_mismatch' });
  expect(await service.get(f.actor, f.ledger, row.id)).toMatchObject({
    name: row.name,
    parent_id: null,
  });
  const allowed = await f.app.inject({
    method: 'PATCH',
    url,
    headers: f.headers,
    payload: { parent_id: expense },
  });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json()).toMatchObject({ parent_id: expense, currency: 'EUR' });
  expect(
    (
      await f.app.inject({
        method: 'PATCH',
        url,
        headers: f.headers,
        payload: { parent_id: null },
      })
    ).statusCode,
  ).toBe(200);
});
it('core create rejects a different kind and accepts same kind with different currency', async () => {
  const service = itemService(f.db);
  await expect(
    service.create(f.actor, f.ledger, {
      name: 'Synthetic denied core child',
      kind: 'expense',
      currency: 'USD',
      parent_id: asset,
    }),
  ).rejects.toMatchObject({ code: 'parent_kind_mismatch', statusCode: 400 });
  expect(
    await service.create(f.actor, f.ledger, {
      name: 'Synthetic core child',
      kind: 'expense',
      currency: 'USD',
      parent_id: expense,
    }),
  ).toMatchObject({ parent_id: expense, kind: 'expense', currency: 'USD' });
});
it('core move rejects a different kind and allows same kind; denial audits no names', async () => {
  const service = itemService(f.db),
    row = await service.create(f.actor, f.ledger, {
      name: 'Synthetic core move',
      kind: 'asset',
      currency: 'JPY',
    });
  await expect(
    service.update(f.actor, f.ledger, row.id, { parent_id: expense }),
  ).rejects.toMatchObject({ code: 'parent_kind_mismatch', statusCode: 400 });
  expect(
    await service.update(f.actor, f.ledger, row.id, { parent_id: asset }),
  ).toMatchObject({ parent_id: asset, currency: 'JPY' });
  const rows =
    await f.db`SELECT action,outcome FROM audit_logs WHERE user_id=${f.actor} AND action='item.update' AND outcome='error'`;
  expect(rows.length).toBeGreaterThan(0);
  expect(JSON.stringify(rows)).not.toContain(row.name);
});
