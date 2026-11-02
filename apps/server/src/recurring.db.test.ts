// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  recurringService,
  runRecurringWorker,
  ledgerService,
  itemService,
} from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>;
let sequence = 0;
beforeAll(async () => {
  f = await fixture('recurring');
});
afterAll(async () => {
  if (f) await f.close();
});
async function setup(options: Record<string, unknown> = {}) {
  const l = await ledgerService(f.db).create(f.actor, {
    name: 'Synthetic recurring ' + ++sequence,
  });
  const a = await itemService(f.db).create(f.actor, l.id, {
      name: 'Synthetic cash',
      kind: 'asset',
      currency: 'TWD',
    }),
    e = await itemService(f.db).create(f.actor, l.id, {
      name: 'Synthetic expense',
      kind: 'expense',
      currency: 'TWD',
    });
  const input = {
    name: 'Synthetic monthly',
    frequency: 'monthly',
    interval: 1,
    day_of_month: 31,
    start_on: '2026-01-01',
    end_on: '2026-04-30',
    template: {
      memo: 'SYNTHETIC_RECURRING_PRIVATE_MEMO',
      entries: [
        { item_id: a.id, amount: '-1234.50' },
        { item_id: e.id, amount: '1234.50' },
      ],
    },
    ...options,
  };
  const r = await recurringService(f.db).save(f.actor, l.id, input);
  return { l, a, e, input, r, s: recurringService(f.db) };
}
const until = new Date('2026-05-01T00:00:00Z');
it('generates monthly Jan31/Feb28/Mar31/Apr30, respects end_on, snapshot and owner isolation', async () => {
  const { l, r, s } = await setup();
  expect((await s.generate(f.actor, l.id, until)).generated).toBe(4);
  const rows = await s.occurrences(f.actor, l.id);
  expect(rows.map((o) => o.occurs_on)).toEqual([
    '2026-01-31',
    '2026-02-28',
    '2026-03-31',
    '2026-04-30',
  ]);
  expect(
    rows.every((o) => o.source_rule_id === r.id && o.status === 'pending'),
  ).toBe(true);
  for (const method of ['GET', 'POST', 'DELETE', 'PUT'] as const) {
    const response = await f.app.inject({
      method,
      url: `/api/ledgers/${l.id}/recurring${method === 'DELETE' || method === 'PUT' ? '/' + r.id : ''}`,
      headers: f.otherHeaders,
      ...(method === 'POST' || method === 'PUT' ? { payload: {} } : {}),
    });
    expect(response.statusCode).toBe(404);
  }
  await expect(
    s.generate(
      String(
        (
          await f.db`SELECT id FROM users WHERE oidc_issuer='https://recurring.synthetic.invalid' AND oidc_subject='stranger'`
        )[0]!.id,
      ),
      l.id,
      until,
    ),
  ).rejects.toMatchObject({ code: 'not_found' });
});
it('manual/worker generation racing and repeat generation are idempotent; no duplicate posting', async () => {
  const { l, r, s } = await setup({ auto_post: true });
  await Promise.all([
    s.generate(f.actor, l.id, until),
    s.generate(f.actor, l.id, until),
    runRecurringWorker(f.db, until),
  ]);
  expect((await s.generate(f.actor, l.id, until)).generated).toBe(0);
  const all = await s.occurrences(f.actor, l.id, { status: 'posted' });
  expect(all).toHaveLength(4);
  await Promise.all([
    s.post(f.actor, l.id, all[0]!.id),
    s.post(f.actor, l.id, all[0]!.id),
  ]);
  const tx =
    await f.db`SELECT source_id FROM transactions WHERE ledger_id=${l.id} AND source_system='recurring'`;
  expect(tx).toHaveLength(4);
  expect(tx.map((t) => t.source_id).sort()).toEqual(
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'].map(
      (d) => r.id + ':' + d,
    ),
  );
});
it('auto_post records archived / locked / missing-rate failures without partial transactions', async () => {
  for (const error of [
    'archived_resource',
    'period_locked',
    'exchange_rate_missing',
  ]) {
    const { l, a, e, s } = await setup({
      auto_post: true,
      end_on: '2026-01-31',
    });
    if (error === 'archived_resource')
      await itemService(f.db).update(f.actor, l.id, a.id, { archived: true });
    if (error === 'period_locked')
      await ledgerService(f.db).setLock(f.actor, l.id, {
        locked_until: '2026-01-31',
      });
    if (error === 'exchange_rate_missing') {
      const fx = await itemService(f.db).create(f.actor, l.id, {
          name: 'Synthetic USD',
          kind: 'asset',
          currency: 'USD',
        }),
        fx2 = await itemService(f.db).create(f.actor, l.id, {
          name: 'Synthetic USD expense',
          kind: 'expense',
          currency: 'USD',
        });
      const state = await s.state(f.actor, l.id);
      await s.save(
        f.actor,
        l.id,
        {
          ...(({ id: _, ledger_id: __, next_on: ___, ...r }) => {
            void _;
            void __;
            void ___;
            return r;
          })(state.rules[0]!),
          template: {
            entries: [
              { item_id: fx.id, amount: '-1' },
              { item_id: fx2.id, amount: '1' },
            ],
          },
        },
        state.rules[0]!.id,
      );
    }
    await s.generate(f.actor, l.id, until);
    const [o] = await s.occurrences(f.actor, l.id);
    expect(o).toMatchObject({
      status: 'failed',
      error_code: error,
      transaction_id: null,
    });
    expect(
      await f.db`SELECT id FROM transactions WHERE ledger_id=${l.id}`,
    ).toHaveLength(0);
    expect(
      await f.db`SELECT id FROM transaction_entries WHERE ledger_id=${l.id}`,
    ).toHaveLength(0);
    void e;
  }
});
it('actual HTTP post failure returns persisted failed state; repair date/amount/memo is occurrence-only then retry succeeds', async () => {
  const { l, r, s } = await setup({ end_on: '2026-01-31' });
  await s.generate(f.actor, l.id, until);
  const [o] = await s.occurrences(f.actor, l.id);
  await ledgerService(f.db).setLock(f.actor, l.id, {
    locked_until: '2026-01-31',
  });
  const request = (
    method: 'PATCH' | 'POST',
    suffix: string,
    payload?: unknown,
  ) =>
    f.app.inject({
      method,
      url: `/api/ledgers/${l.id}/recurring/occurrences/${o!.id}` + suffix,
      headers: f.headers,
      ...(payload ? { payload } : {}),
    });
  const failed = await request('POST', '/post');
  expect(failed.statusCode).toBe(200);
  expect(failed.json()).toMatchObject({
    status: 'failed',
    error_code: 'period_locked',
  });
  expect(
    (await request('PATCH', '', { occurred_on: '2026-01-31' })).statusCode,
  ).toBe(409);
  const entries = o!.template.entries.map((e, i) => ({
    ...e,
    amount: i ? '99.99' : '-99.99',
  }));
  const changed = await request('PATCH', '', {
    occurred_on: '2026-02-01',
    memo: 'SYNTHETIC_CURRENT_PRIVATE',
    entries,
  });
  expect(changed.statusCode).toBe(200);
  const posted = await request('POST', '/post');
  expect(posted.json().status).toBe('posted');
  expect((await s.state(f.actor, l.id)).rules[0]!.template.memo).toBe(
    'SYNTHETIC_RECURRING_PRIVATE_MEMO',
  );
  const [tx] =
    await f.db`SELECT occurred_on::text,memo,source_id FROM transactions WHERE id=${posted.json().transaction_id}`;
  expect(tx).toMatchObject({
    occurred_on: '2026-02-01',
    memo: 'SYNTHETIC_CURRENT_PRIVATE',
    source_id: r.id + ':2026-01-31',
  });
});
it('bulk posts each occurrence, skips, inactive rules do not generate; deleting retains posted transactions', async () => {
  const { l, r, s, input } = await setup();
  await s.save(f.actor, l.id, { ...input, active: false }, r.id);
  expect((await s.generate(f.actor, l.id, until)).generated).toBe(0);
  await s.save(f.actor, l.id, input, r.id);
  await s.generate(f.actor, l.id, until);
  const rows = await s.occurrences(f.actor, l.id);
  await s.skip(f.actor, l.id, rows[0]!.id);
  const result = await s.bulkPost(f.actor, l.id, {
    ids: rows.slice(1, 3).map((o) => o.id),
  });
  expect(result.every((o) => o.status === 'posted')).toBe(true);
  await s.remove(f.actor, l.id, r.id);
  expect(
    await f.db`SELECT id FROM transactions WHERE ledger_id=${l.id}`,
  ).toHaveLength(2);
  expect(await s.occurrences(f.actor, l.id)).toHaveLength(0);
  const posted = await s.occurrences(f.actor, l.id, { status: 'posted' });
  expect(
    posted.every((o) => o.rule_id === null && o.source_rule_id === r.id),
  ).toBe(true);
});
it('recurrence HTTP validates Origin/session, strict schema, actor and foreign ledger references', async () => {
  const { l, r, input } = await setup();
  const url = `/api/ledgers/${l.id}/recurring`;
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url,
        payload: input,
        headers: { origin: f.headers.origin },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url,
        payload: input,
        headers: { ...f.headers, origin: 'https://evil.invalid' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        method: 'PUT',
        url: url + '/' + r.id,
        payload: { ...input, owner_id: f.actor },
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(400);
  const other = await setup();
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url,
        payload: {
          ...input,
          name: 'foreign',
          template: {
            entries: [
              { item_id: other.a.id, amount: '-1' },
              { item_id: other.e.id, amount: '1' },
            ],
          },
        },
        headers: f.headers,
      })
    ).json(),
  ).toEqual({ error: 'item_ledger_mismatch' });
});
it('worker waits until06, concurrent workers claim once, durable status is owner-only', async () => {
  const { l, s } = await setup({ auto_post: true, end_on: '2026-01-31' });
  await runRecurringWorker(f.db, new Date('2026-01-31T21:59:59Z'));
  expect(await s.occurrences(f.actor, l.id)).toHaveLength(0);
  const now = new Date('2026-01-31T22:00:00Z');
  await Promise.all([
    runRecurringWorker(f.db, now),
    runRecurringWorker(f.db, now),
  ]);
  const state = await s.state(f.actor, l.id);
  expect(state.worker).toMatchObject({ status: 'success', error_code: null });
  expect(await s.occurrences(f.actor, l.id, { status: 'posted' })).toHaveLength(
    1,
  );
  expect((await runRecurringWorker(f.db, now)).skipped).toBeGreaterThan(0);
});
it('systemic worker failure backs off durably without repeated audit, then retries and resets without duplicates', async () => {
  const { l, s } = await setup({
    name: 'Synthetic worker retry',
    auto_post: true,
    end_on: '2026-01-31',
  });
  const now = new Date('2026-02-01T00:00:00Z');
  await f.db.unsafe(
    `CREATE FUNCTION synthetic_recurring_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.rule_name='Synthetic worker retry' THEN RAISE EXCEPTION 'synthetic worker outage'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_recurring_outage BEFORE INSERT ON recurring_occurrences FOR EACH ROW EXECUTE FUNCTION synthetic_recurring_failure();`,
  );
  try {
    expect((await runRecurringWorker(f.db, now)).errors).toBeGreaterThan(0);
    expect((await s.state(f.actor, l.id)).worker).toMatchObject({
      status: 'error',
      error_code: 'worker_failed',
    });
    const [before] =
      await f.db`SELECT count(*)::int n FROM audit_logs WHERE user_id=${f.actor} AND action='recurring.generate'`;
    expect(
      (await runRecurringWorker(f.db, new Date(now.getTime() + 30000))).skipped,
    ).toBeGreaterThan(0);
    const [after] =
      await f.db`SELECT count(*)::int n FROM audit_logs WHERE user_id=${f.actor} AND action='recurring.generate'`;
    expect(after!.n).toBe(before!.n);
    await runRecurringWorker(f.db, new Date(now.getTime() + 300000));
    const [retry] =
      await f.db`SELECT failure_count,next_retry_at::text FROM recurring_worker_runs WHERE ledger_id=${l.id}`;
    expect(retry!.failure_count).toBe(2);
    expect(new Date(retry!.next_retry_at).getTime()).toBe(
      now.getTime() + 900000,
    );
  } finally {
    await f.db.unsafe(
      'DROP TRIGGER synthetic_recurring_outage ON recurring_occurrences; DROP FUNCTION synthetic_recurring_failure();',
    );
  }
  await runRecurringWorker(f.db, new Date(now.getTime() + 900000));
  expect((await s.state(f.actor, l.id)).worker).toMatchObject({
    status: 'success',
    next_retry_at: null,
  });
  const [reset] =
    await f.db`SELECT failure_count FROM recurring_worker_runs WHERE ledger_id=${l.id}`;
  expect(reset!.failure_count).toBe(0);
  expect(await s.occurrences(f.actor, l.id, { status: 'posted' })).toHaveLength(
    1,
  );
});
it('audit includes all six actions and failed outcomes, never names/memo/amount/date/template', async () => {
  const rows =
    await f.db`SELECT row_to_json(a)::text body FROM audit_logs a WHERE user_id=${f.actor} AND action LIKE 'recurring.%'`;
  for (const action of [
    'create',
    'update',
    'delete',
    'generate',
    'post',
    'skip',
  ])
    expect(
      rows.some((r) => JSON.parse(r.body).action === 'recurring.' + action),
    ).toBe(true);
  expect(
    rows.some((r) => {
      const a = JSON.parse(r.body);
      return a.action === 'recurring.post' && a.outcome === 'error';
    }),
  ).toBe(true);
  for (const value of [
    'SYNTHETIC_RECURRING_PRIVATE_MEMO',
    'SYNTHETIC_CURRENT_PRIVATE',
    '1234.50',
    '2026-01-31',
    'template',
    'Synthetic worker retry',
  ])
    expect(JSON.stringify(rows)).not.toContain(value);
});
