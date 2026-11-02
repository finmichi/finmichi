// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture } from '../test/catalog-fixture.js';
import { seedDeletionLedger } from '../../../scripts/data-reset-fixture.mjs';
let f: Awaited<ReturnType<typeof fixture>>,
  seeded: Awaited<ReturnType<typeof seedDeletionLedger>>;
beforeAll(async () => {
  f = await fixture('managed-transactions');
  seeded = await seedDeletionLedger(f.db, f.actor, f.ledger);
});
afterAll(async () => {
  if (f) await f.close();
});
it('detail and cursor list expose same-ledger dividend/deposit management ids without changing entries or generic-edit guards', async () => {
  const root = `/api/ledgers/${f.ledger}/transactions`;
  const list = (await f.app.inject({ url: root, headers: f.headers })).json();
  for (const [key, expected, id, error] of [
    [
      'dividend_id',
      seeded.dividend.id,
      seeded.dividend.transaction_id,
      'dividend_managed_transaction',
    ],
    [
      'deposit_id',
      seeded.deposit.id,
      seeded.posting.transaction_id,
      'deposit_managed_transaction',
    ],
  ]) {
    const response = await f.app.inject({
      url: root + '/' + id,
      headers: f.headers,
    });
    expect(response.statusCode).toBe(200);
    const detail = response.json();
    expect(detail[key!]).toBe(expected);
    expect(list.items.find((r: { id: string }) => r.id === id)[key!]).toBe(
      expected,
    );
    for (const method of ['PATCH', 'DELETE'] as const) {
      const r = await f.app.inject({
        method,
        url: root + '/' + id,
        headers: f.headers,
        ...(method === 'PATCH'
          ? { payload: { memo: '合成禁止一般修改' } }
          : {}),
      });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error });
    }
    expect(
      (await f.app.inject({ url: root + '/' + id, headers: f.headers })).json(),
    ).toEqual(detail);
    expect(
      (await f.app.inject({ url: root + '/' + id, headers: f.otherHeaders }))
        .statusCode,
    ).toBe(404);
  }
  const plain = list.items.find((r: { id: string }) => r.id === seeded.tx.id);
  expect(plain.dividend_id).toBeNull();
  expect(plain.deposit_id).toBeNull();
  expect(
    (await f.app.inject({ url: root, headers: f.otherHeaders })).statusCode,
  ).toBe(404);
  expect(
    (
      await f.app.inject({
        url: `/api/ledgers/${f.ledger}/dividends/${seeded.dividend.id}`,
        headers: f.otherHeaders,
      })
    ).statusCode,
  ).toBe(404);
});
