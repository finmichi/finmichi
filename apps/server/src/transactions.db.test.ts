// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  itemService,
  ledgerService,
  namedRecordService,
  transactionService,
} from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>;
let cash: string,
  expense: string,
  usd: string,
  usdExpense: string,
  income: string,
  equity: string;
const path = () => `/api/ledgers/${f.ledger}/transactions`;
const body = (entries: unknown[]) => ({
  occurred_on: '2026-10-17',
  memo: 'synthetic private memo',
  entries,
});
const leg = (item_id: string, amount: string, exchange_rate?: string) => ({
  item_id,
  amount,
  ...(exchange_rate === undefined ? {} : { exchange_rate }),
});
async function request(
  method: 'POST' | 'PATCH' | 'DELETE' | 'GET',
  suffix = '',
  payload?: unknown,
  headers = f.headers,
) {
  return f.app.inject({
    method,
    url: path() + suffix,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
}
beforeAll(async () => {
  f = await fixture('transactions');
  const service = itemService(f.db);
  async function item(name: string, kind: string, currency = 'TWD') {
    return (await service.create(f.actor, f.ledger, { name, kind, currency }))
      .id;
  }
  cash = await item('Synthetic cash', 'asset');
  expense = await item('Synthetic expense', 'expense');
  usd = await item('Synthetic USD', 'asset', 'USD');
  usdExpense = await item('Synthetic USD expense', 'expense', 'USD');
  income = await item('Synthetic income', 'income');
  equity = await item('Synthetic equity', 'equity');
  await f.db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES (${f.ledger},'2026-10-17','USD','TWD','32.567')`;
});
afterAll(async () => {
  if (f) await f.close();
});
it('A HTTP → DB, derives kind and atomically replaces/deletes all entries; audit excludes money and memo', async () => {
  const created = await request(
    'POST',
    '',
    body([leg(cash, '-12.34'), leg(expense, '12.34')]),
  );
  expect(created.statusCode).toBe(201);
  const tx = created.json();
  expect(tx.kind).toBe('expense');
  expect(tx.entries.map((e: { base_amount: string }) => e.base_amount)).toEqual(
    ['-12.340000', '12.340000'],
  );
  const before = tx.entries.map((e: { id: string }) => e.id);
  const changed = await request('PATCH', '/' + tx.id, {
    memo: 'changed synthetic secret',
    entries: [leg(income, '-55'), leg(cash, '55')],
  });
  expect(changed.statusCode).toBe(200);
  expect(changed.json().kind).toBe('income');
  expect(
    changed.json().entries.every((e: { id: string }) => !before.includes(e.id)),
  ).toBe(true);
  const failed = await request('PATCH', '/' + tx.id, {
    memo: 'should rollback',
    entries: [leg(cash, '-1'), leg(expense, '2')],
  });
  expect(failed.json()).toEqual({ error: 'unbalanced' });
  const read = await request('GET', '/' + tx.id);
  expect(read.json().memo).toBe('changed synthetic secret');
  expect(read.json().entries.map((e: { amount: string }) => e.amount)).toEqual([
    '-55.000000',
    '55.000000',
  ]);
  expect((await request('DELETE', '/' + tx.id)).statusCode).toBe(204);
  expect(
    await f.db`SELECT id FROM transaction_entries WHERE transaction_id=${tx.id}`,
  ).toHaveLength(0);
  const audits =
    await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} AND action LIKE 'transaction.%'`;
  expect(audits.map((a) => a.action)).toEqual(
    expect.arrayContaining([
      'transaction.create',
      'transaction.update',
      'transaction.delete',
    ]),
  );
  expect(JSON.stringify(audits)).not.toMatch(
    /private memo|changed synthetic secret|12\.34|55\.00/,
  );
});
it.each([
  {
    name: 'manual without daily rate',
    date: '2026-10-18',
    rate: '32.5',
    paid: '4000',
    effective: '40.0000000000',
    reference: '32.5000000000',
    source: 'user_input',
    percent: '23.0769230769',
    warn: true,
  },
  {
    name: 'manual overrides daily rate',
    date: '2026-10-17',
    rate: '32.5',
    paid: '4000',
    effective: '40.0000000000',
    reference: '32.5000000000',
    source: 'user_input',
    percent: '23.0769230769',
    warn: true,
  },
  {
    name: 'daily rate only',
    date: '2026-10-17',
    rate: undefined,
    paid: '4000',
    effective: '40.0000000000',
    reference: '32.5670000000',
    source: 'exchange_rates',
    percent: '22.8237172598',
    warn: true,
  },
  {
    name: 'within 5 percent',
    date: '2026-10-18',
    rate: '32.5',
    paid: '3251',
    effective: '32.5100000000',
    reference: '32.5000000000',
    source: 'user_input',
    percent: '0.0307692308',
    warn: false,
  },
  {
    name: 'exactly 5 percent',
    date: '2026-10-18',
    rate: '32.5',
    paid: '3412.50',
    effective: '34.1250000000',
    reference: '32.5000000000',
    source: 'user_input',
    percent: '5.0000000000',
    warn: false,
  },
  {
    name: 'no reference',
    date: '2026-10-18',
    rate: undefined,
    paid: '4000',
    effective: '40.0000000000',
    reference: null,
    source: 'none',
    percent: null,
    warn: false,
  },
])(
  'C $name: preview/create/update expose the effective rate and reference comparison',
  async (c) => {
    const payload = {
      ...body([leg(usd, '-100', c.rate), leg(cash, c.paid)]),
      occurred_on: c.date,
    };
    const expected = {
      scenario: 'C',
      warnings: c.warn ? [{ code: 'fx_rate_deviation', entryIndex: 0 }] : [],
      fx_comparisons: [
        {
          entry_index: 0,
          effective_rate: c.effective,
          reference_rate: c.reference,
          reference_source: c.source,
          deviation_percent: c.percent,
        },
      ],
    };
    const preview = await request('POST', '/preview', payload);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject(expected);
    const saved = await request('POST', '', payload);
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject(expected);
    const id = saved.json().id;
    expect(
      (await request('POST', '/' + id + '/preview', payload)).json(),
    ).toMatchObject(expected);
    const updated = await request('PATCH', '/' + id, payload);
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject(expected);
    const [stored] =
      await f.db`SELECT exchange_rate::text,base_amount::text FROM transaction_entries WHERE transaction_id=${id} AND entry_position=0`;
    expect(stored!.exchange_rate).toBe(c.effective);
    expect(stored!.base_amount).toBe(
      '-' +
        c.paid.replace(/\.50$/, '') +
        (c.paid.endsWith('.50') ? '.500000' : '.000000'),
    );
  },
);
it('C metadata-only update does not label a stored effective rate as a user-supplied reference', async () => {
  const tx = (
    await request(
      'POST',
      '',
      body([leg(usd, '-100', '32.5'), leg(cash, '4000')]),
    )
  ).json();
  const updated = await request('PATCH', '/' + tx.id, {
    memo: 'synthetic metadata only',
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().fx_comparisons).toMatchObject([
    { reference_source: 'exchange_rates', reference_rate: '32.5670000000' },
  ]);
});
it('C invalid explicit reference is rejected instead of falling back to the daily rate', async () => {
  expect(
    (
      await request(
        'POST',
        '/preview',
        body([leg(usd, '-100', '0'), leg(cash, '4000')]),
      )
    ).json(),
  ).toEqual({ error: 'invalid_money_entry' });
});
it('BD uses dated defaults and persists input order for rounding ties', async () => {
  const r = await request(
    'POST',
    '',
    body([leg(usd, '-33.33'), leg(usdExpense, '33.33')]),
  );
  expect(r.statusCode).toBe(201);
  expect(r.json().scenario).toBe('BD');
  expect(
    r.json().entries.map((e: { base_amount: string }) => e.base_amount),
  ).toEqual(['-1085.460000', '1085.460000']);
  const three = await request(
    'POST',
    '',
    body([
      leg(usd, '0.005', '1'),
      leg(usdExpense, '0.005', '1'),
      leg(usd, '-0.010', '1'),
    ]),
  );
  expect(three.statusCode).toBe(201);
  expect(
    three.json().entries.map((e: { base_amount: string }) => e.base_amount),
  ).toEqual(['0.010000', '0.010000', '-0.020000']);
  const updated = await request('PATCH', '/' + three.json().id, {
    invoice_no: 'synthetic-invoice',
  });
  expect(updated.statusCode).toBe(200);
  expect(
    updated.json().entries.map((e: { base_amount: string }) => e.base_amount),
  ).toEqual(['0.010000', '0.010000', '-0.020000']);
});
it('returns defined monetary errors and rejects user-supplied kind or base amounts', async () => {
  for (const [entries, error] of [
    [
      [leg(usd, '0.000001', '1'), leg(usdExpense, '-0.000001', '1')],
      'base_amount_rounds_to_zero',
    ],
    [
      [leg(usd, '1', '1'), leg(usdExpense, '1', '1')],
      'fx_residual_exceeds_tolerance',
    ],
    [[leg(cash, '-1'), leg(expense, '1.001')], 'invalid_money_entry'],
  ] as const) {
    expect((await request('POST', '', body([...entries]))).json()).toEqual({
      error,
    });
  }
  expect(
    (
      await request('POST', '', {
        ...body([leg(cash, '-1'), leg(expense, '1')]),
        kind: 'income',
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await request(
        'POST',
        '',
        body([{ ...leg(cash, '-1'), base_amount: '-1' }, leg(expense, '1')]),
      )
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await request('POST', '', {
        ...body([leg(cash, '-1'), leg(expense, '1')]),
        occurred_on: '2026-02-30',
      })
    ).statusCode,
  ).toBe(400);
});
it('derives income precedence, transfer and adjustment from items', async () => {
  for (const [entries, kind] of [
    [[leg(income, '-1'), leg(expense, '1')], 'income'],
    [[leg(cash, '-1'), leg(cash, '1')], 'transfer'],
    [[leg(equity, '-1'), leg(cash, '1')], 'adjustment'],
  ] as const) {
    const r = await request('POST', '', body([...entries]));
    expect(r.statusCode).toBe(201);
    expect(r.json().kind).toBe(kind);
  }
});
it('enforces ownership in HTTP and core for every operation', async () => {
  const payload = body([leg(cash, '-1'), leg(expense, '1')]),
    tx = (await request('POST', '', payload)).json();
  expect((await f.app.inject(path())).statusCode).toBe(401);
  expect(
    (
      await request('POST', '', payload, {
        ...f.headers,
        origin: 'https://evil.invalid',
      })
    ).statusCode,
  ).toBe(403);
  for (const [method, suffix, input] of [
    ['GET', '', undefined],
    ['GET', '/' + tx.id, undefined],
    ['POST', '', payload],
    ['POST', '/preview', payload],
    ['POST', '/' + tx.id + '/preview', payload],
    ['PATCH', '/' + tx.id, { memo: 'denied' }],
    ['DELETE', '/' + tx.id, undefined],
  ] as const) {
    expect(
      (await request(method, suffix, input, f.otherHeaders)).statusCode,
    ).toBe(404);
  }
  const [stranger] =
    await f.db`SELECT id FROM users WHERE oidc_issuer='https://transactions.synthetic.invalid' AND oidc_subject='stranger'`;
  await expect(
    transactionService(f.db).update(String(stranger!.id), f.ledger, tx.id, {
      memo: 'denied',
    }),
  ).rejects.toMatchObject({ code: 'not_found' });
  const other = await ledgerService(f.db).create(f.actor, {
    name: 'Synthetic second transaction ledger',
  });
  for (const [resource, error] of [
    ['payees', 'payee_ledger_mismatch'],
    ['projects', 'project_ledger_mismatch'],
  ] as const) {
    const foreign = await namedRecordService(f.db, resource).create(
      f.actor,
      other.id,
      { name: 'Synthetic foreign' },
    );
    const key = resource === 'payees' ? 'payee_id' : 'project_id';
    expect(
      (await request('POST', '', { ...payload, [key]: foreign.id })).json(),
    ).toEqual({ error });
  }
  const foreignItem = await itemService(f.db).create(f.actor, other.id, {
    name: 'Synthetic foreign item',
    kind: 'asset',
    currency: 'TWD',
  });
  expect(
    (
      await request(
        'POST',
        '',
        body([leg(foreignItem.id, '-1'), leg(expense, '1')]),
      )
    ).json(),
  ).toEqual({ error: 'item_ledger_mismatch' });
});
it('blocks archived resources on new use; allows history and metadata-only edits without changing archived legs', async () => {
  const archivedItem = await itemService(f.db).create(f.actor, f.ledger, {
    name: 'Synthetic archived cash',
    kind: 'asset',
    currency: 'TWD',
  });
  const payee = await namedRecordService(f.db, 'payees').create(
      f.actor,
      f.ledger,
      { name: 'Synthetic archived payee' },
    ),
    project = await namedRecordService(f.db, 'projects').create(
      f.actor,
      f.ledger,
      { name: 'Synthetic archived project' },
    );
  const payload = {
    ...body([leg(archivedItem.id, '-10'), leg(expense, '10')]),
    payee_id: payee.id,
    project_id: project.id,
  };
  const tx = (await request('POST', '', payload)).json();
  await itemService(f.db).update(f.actor, f.ledger, archivedItem.id, {
    archived: true,
  });
  await namedRecordService(f.db, 'payees').update(f.actor, f.ledger, payee.id, {
    archived: true,
  });
  await namedRecordService(f.db, 'projects').update(
    f.actor,
    f.ledger,
    project.id,
    { archived: true },
  );
  expect((await request('POST', '', payload)).json()).toEqual({
    error: 'archived_resource',
  });
  expect((await request('GET', '/' + tx.id)).statusCode).toBe(200);
  expect(
    (await request('POST', '/' + tx.id + '/preview', payload)).statusCode,
  ).toBe(200);
  expect(
    (
      await request('POST', '/' + tx.id + '/preview', {
        ...payload,
        entries: [leg(archivedItem.id, '-11'), leg(expense, '11')],
      })
    ).json(),
  ).toEqual({ error: 'archived_resource' });
  expect(
    (await request('PATCH', '/' + tx.id, { memo: 'still editable' }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await request('PATCH', '/' + tx.id, {
        entries: [leg(archivedItem.id, '-11'), leg(expense, '11')],
      })
    ).json(),
  ).toEqual({ error: 'archived_resource' });
  const active = { ...body([leg(cash, '-1'), leg(expense, '1')]) };
  for (const extra of [{ payee_id: payee.id }, { project_id: project.id }])
    expect((await request('POST', '', { ...active, ...extra })).json()).toEqual(
      { error: 'archived_resource' },
    );
});
it('uses exact-date rates, permits manual rates and rejects missing defaults', async () => {
  const r = await f.app.inject({
    url: `/api/ledgers/${f.ledger}/exchange-rates?date=2026-10-17`,
    headers: f.headers,
  });
  expect(r.json()).toEqual([
    { from_currency: 'USD', to_currency: 'TWD', rate: '32.5670000000' },
  ]);
  const payload = {
    ...body([leg(usd, '-1'), leg(usdExpense, '1')]),
    occurred_on: '2026-10-18',
  };
  expect((await request('POST', '', payload)).json()).toEqual({
    error: 'exchange_rate_missing',
  });
  expect(
    (
      await request('POST', '', {
        ...payload,
        entries: [leg(usd, '-1', '33'), leg(usdExpense, '1', '33')],
      })
    ).statusCode,
  ).toBe(201);
});
it('locks inclusive dates and checks both old and new date on updates', async () => {
  const tx = (
    await request('POST', '', body([leg(cash, '-1'), leg(expense, '1')]))
  ).json();
  await f.db`UPDATE ledgers SET locked_until='2026-10-17' WHERE id=${f.ledger}`;
  for (const date of ['2026-10-16', '2026-10-17'])
    expect(
      (
        await request('POST', '', {
          ...body([leg(cash, '-1'), leg(expense, '1')]),
          occurred_on: date,
        })
      ).json(),
    ).toEqual({ error: 'period_locked' });
  expect(
    (await request('PATCH', '/' + tx.id, { occurred_on: '2026-10-18' })).json(),
  ).toEqual({ error: 'period_locked' });
  expect((await request('DELETE', '/' + tx.id)).json()).toEqual({
    error: 'period_locked',
  });
  const unlocked = await request('POST', '', {
    ...body([leg(cash, '-1'), leg(expense, '1')]),
    occurred_on: '2026-10-18',
  });
  expect(unlocked.statusCode).toBe(201);
  expect(
    (
      await request('PATCH', '/' + unlocked.json().id, {
        occurred_on: '2026-10-17',
      })
    ).json(),
  ).toEqual({ error: 'period_locked' });
  await f.db`UPDATE ledgers SET locked_until=NULL WHERE id=${f.ledger}`;
});
