// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ledgerService, itemService, transactionService } from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture('ledger-lock');
});
afterAll(async () => {
  if (f) await f.close();
});
const patch = (payload: unknown, headers = f.headers, id = f.ledger) =>
  f.app.inject({
    method: 'PATCH',
    url: `/api/ledgers/${id}/lock`,
    headers,
    payload,
  });
it('advances lock, rejects unconfirmed earlier / clear with 409; confirmed changes persist and remain readable', async () => {
  for (const locked_until of ['2026-09-01', '2026-09-30', '2026-09-30']) {
    const r = await patch({ locked_until });
    expect(r.statusCode).toBe(200);
    expect(r.json().locked_until).toBe(locked_until);
  }
  for (const locked_until of ['2026-09-29', null]) {
    for (const extra of [{}, { confirm_unlock: false }]) {
      const r = await patch({ locked_until, ...extra });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'unlock_confirmation_required' });
      expect(
        (await ledgerService(f.db).get(f.actor, f.ledger)).locked_until,
      ).toBe('2026-09-30');
    }
  }
  expect(
    (await patch({ locked_until: '2026-09-29', confirm_unlock: true }))
      .statusCode,
  ).toBe(200);
  expect(
    (await patch({ locked_until: null, confirm_unlock: true })).json()
      .locked_until,
  ).toBeNull();
});
it('validates future / impossible dates, strict flags and field allowlist; cookie and Origin guards unchanged', async () => {
  for (const payload of [
    { locked_until: '9999-12-31' },
    { locked_until: '2026-02-30' },
    { locked_until: null, confirm_unlock: 'true' },
    { locked_until: null, name: 'nope' },
    {},
  ])
    expect((await patch(payload)).statusCode).toBe(400);
  expect(
    (
      await patch({ locked_until: null }, {
        origin: f.headers.origin,
      } as typeof f.headers)
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await patch(
        { locked_until: null },
        { ...f.headers, origin: 'https://evil.invalid' },
      )
    ).statusCode,
  ).toBe(403);
});
it('enforces owner isolation in REST and core, even with explicit confirmation', async () => {
  const r = await patch(
    { locked_until: null, confirm_unlock: true },
    f.otherHeaders,
  );
  expect(r.statusCode).toBe(404);
  expect(r.json()).toEqual({ error: 'not_found' });
  const [other] =
    await f.db`SELECT id FROM users WHERE oidc_issuer='https://ledger-lock.synthetic.invalid' AND oidc_subject='stranger'`;
  await expect(
    ledgerService(f.db).setLock(String(other!.id), f.ledger, {
      locked_until: null,
      confirm_unlock: true,
    }),
  ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
});
it('new settings enforce inclusive create / update old+new / delete boundaries, with recovery after unlock', async () => {
  const items = itemService(f.db),
    txs = transactionService(f.db);
  const a = await items.create(f.actor, f.ledger, {
    name: 'synthetic cash',
    kind: 'asset',
    currency: 'TWD',
  });
  const e = await items.create(f.actor, f.ledger, {
    name: 'synthetic expense',
    kind: 'expense',
    currency: 'TWD',
  });
  const body = (occurred_on: string) => ({
    occurred_on,
    memo: 'SYNTHETIC_LOCK_PRIVATE_MEMO',
    entries: [
      { item_id: a.id, amount: '-12345.67' },
      { item_id: e.id, amount: '12345.67' },
    ],
  });
  const tx = await txs.create(f.actor, f.ledger, body('2026-09-30'));
  await ledgerService(f.db).setLock(f.actor, f.ledger, {
    locked_until: '2026-09-30',
  });
  for (const date of ['2026-09-29', '2026-09-30']) {
    await expect(
      txs.create(f.actor, f.ledger, body(date)),
    ).rejects.toMatchObject({ code: 'period_locked' });
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/ledgers/${f.ledger}/transactions`,
      headers: f.headers,
      payload: body(date),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'period_locked' });
  }
  await expect(
    txs.update(f.actor, f.ledger, tx.id, { occurred_on: '2026-10-01' }),
  ).rejects.toMatchObject({ code: 'period_locked' });
  await expect(txs.remove(f.actor, f.ledger, tx.id)).rejects.toMatchObject({
    code: 'period_locked',
  });
  const open = await txs.create(f.actor, f.ledger, body('2026-10-01'));
  await expect(
    txs.update(f.actor, f.ledger, open.id, { occurred_on: '2026-09-30' }),
  ).rejects.toMatchObject({ code: 'period_locked' });
  await ledgerService(f.db).setLock(f.actor, f.ledger, {
    locked_until: null,
    confirm_unlock: true,
  });
  await txs.update(f.actor, f.ledger, tx.id, {
    memo: 'SYNTHETIC_LOCK_PRIVATE_MEMO updated',
  });
  await txs.remove(f.actor, f.ledger, tx.id);
});
it('serializes against the actual previous lock, never a stale pre-transaction read', async () => {
  const l = await ledgerService(f.db).create(f.actor, {
    name: 'synthetic lock race',
  });
  let release!: () => void, ready!: () => void;
  const signal = new Promise<void>((r) => {
    ready = r;
  });
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const first = f.db.begin(async (sql) => {
    await sql`UPDATE ledgers SET locked_until='2026-09-30' WHERE id=${l.id}`;
    ready();
    await barrier;
  });
  await signal;
  const second = ledgerService(f.db).setLock(f.actor, l.id, {
    locked_until: '2026-09-01',
  });
  // Install the rejection handler before releasing the held lock.
  const rejected = expect(second).rejects.toMatchObject({
    code: 'unlock_confirmation_required',
  });
  release();
  await first;
  await rejected;
  expect((await ledgerService(f.db).get(f.actor, l.id)).locked_until).toBe(
    '2026-09-30',
  );
});
it('audits actions / outcomes only; filters include new actions and full rows contain no dates or payload', async () => {
  const rows =
    await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} AND action IN ('ledger.lock','ledger.unlock')`;
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'ledger.lock', outcome: 'success' }),
      expect.objectContaining({ action: 'ledger.unlock', outcome: 'success' }),
      expect.objectContaining({ action: 'ledger.unlock', outcome: 'error' }),
    ]),
  );
  const full = JSON.stringify(rows);
  for (const forbidden of [
    '2026-09-',
    'locked_until',
    'confirm_unlock',
    'SYNTHETIC_LOCK_PRIVATE_MEMO',
    '12345.67',
    'cookie',
    'SYNTHETIC_PRIVATE_TOKEN',
    'session=',
  ])
    expect(full).not.toContain(forbidden);
  for (const action of ['ledger.lock', 'ledger.unlock']) {
    const r = await f.app.inject({
      url: '/api/audit-logs?action=' + action,
      headers: f.headers,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().items.length).toBeGreaterThan(0);
    expect(
      r.json().items.every((a: { action: string }) => a.action === action),
    ).toBe(true);
  }
});
