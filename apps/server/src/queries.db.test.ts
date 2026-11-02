// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  itemService,
  ledgerService,
  namedRecordService,
  transactionService,
  queryService,
  moneyUnits,
} from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>;
let cash: string,
  food: string,
  travel: string,
  salary: string,
  expenseRoot: string,
  foodParent: string,
  payee: string,
  project: string;
const ids: string[] = [];
const url = (q: Record<string, string> = {}, suffix = '') =>
  `/api/ledgers/${f.ledger}/transactions${suffix}?${new URLSearchParams(q)}`;
async function get(
  q: Record<string, string> = {},
  suffix = '',
  headers = f.headers,
) {
  return f.app.inject({ url: url(q, suffix), headers });
}
beforeAll(async () => {
  f = await fixture('queries');
  const items = itemService(f.db);
  async function item(
    name: string,
    kind: string,
    parent_id: string | null = null,
  ) {
    return (
      await items.create(f.actor, f.ledger, {
        name,
        kind,
        currency: 'TWD',
        parent_id,
      })
    ).id;
  }
  cash = await item('現金', 'asset');
  expenseRoot = await item('費用', 'expense');
  foodParent = await item('飲食', 'expense', expenseRoot);
  food = await item('餐費', 'expense', foodParent);
  travel = await item('交通', 'expense', expenseRoot);
  salary = await item('薪資', 'income');
  payee = (
    await namedRecordService(f.db, 'payees').create(f.actor, f.ledger, {
      name: 'Synthetic payee',
    })
  ).id;
  project = (
    await namedRecordService(f.db, 'projects').create(f.actor, f.ledger, {
      name: 'Synthetic project',
    })
  ).id;
  const inputs = [
    {
      occurred_on: '2026-10-01',
      memo: 'Synthetic T1 lunch',
      invoice_no: 'INV-AbC',
      payee_id: payee,
      project_id: project,
      entries: [
        { item_id: cash, amount: '-120' },
        { item_id: food, amount: '120' },
      ],
    },
    {
      occurred_on: '2026-10-05',
      memo: 'Synthetic T2 salary',
      entries: [
        { item_id: salary, amount: '-35000' },
        { item_id: cash, amount: '35000' },
      ],
    },
    {
      occurred_on: '2026-10-09',
      memo: 'Synthetic T3 ABC',
      payee_id: payee,
      project_id: project,
      entries: [
        { item_id: cash, amount: '-1000' },
        { item_id: food, amount: '600' },
        { item_id: travel, amount: '400' },
      ],
    },
  ];
  for (const input of inputs)
    ids.push(
      (await transactionService(f.db).create(f.actor, f.ledger, input)).id,
    );
});
afterAll(async () => {
  if (f) await f.close();
});
it('ADR0004 T1–T3 details and inclusive amount bounds distinguish gross from selected net', async () => {
  const r = await get({ item_id: cash });
  expect(r.statusCode).toBe(200);
  const data = r.json();
  expect(data.totals.count).toBe(3);
  expect(data.items.map((t: { id: string }) => t.id)).toEqual([
    ids[2],
    ids[1],
    ids[0],
  ]);
  expect(
    data.items.map((t: { transaction_amount: string }) =>
      moneyUnits(t.transaction_amount),
    ),
  ).toEqual([1000n, 35000n, 120n].map((n) => n * 1000000n));
  expect(
    data.items.map((t: { selected_net_amount: string }) =>
      moneyUnits(t.selected_net_amount),
    ),
  ).toEqual([-1000n, 35000n, -120n].map((n) => n * 1000000n));
  expect(
    (await get({ amount_min: '100', amount_max: '1000' }))
      .json()
      .items.map((t: { id: string }) => t.id),
  ).toEqual([ids[2], ids[0]]);
  expect(
    (await get({ amount_min: '120', amount_max: '120' }))
      .json()
      .items.map((t: { id: string }) => t.id),
  ).toEqual([ids[0]]);
  const selected = (await get({ item_id: foodParent })).json();
  expect(selected.items[0].transaction_amount).toBe('1000.000000');
  expect(selected.items[0].selected_net_amount).toBe('600.000000');
  expect((await get({ item_id: expenseRoot })).json().totals.count).toBe(2);
});
it('ADR0004 monthly × kind grouping and monthly selected net', async () => {
  const summary = (await get({ group_by: 'month' }, '/summary')).json();
  expect(summary.months).toEqual([
    {
      month: '2026-10',
      kind: 'expense',
      count: 2,
      transaction_amount: '1120.000000',
      selected_net_amount: null,
    },
    {
      month: '2026-10',
      kind: 'income',
      count: 1,
      transaction_amount: '35000.000000',
      selected_net_amount: null,
    },
  ]);
  const selected = (
    await get({ group_by: 'month', item_id: cash }, '/summary')
  ).json();
  expect(selected.monthly_net).toEqual([
    { month: '2026-10', selected_net_amount: '33880.000000' },
  ]);
  expect(
    selected.months.map(
      (m: { selected_net_amount: string }) => m.selected_net_amount,
    ),
  ).toEqual(['-1120.000000', '35000.000000']);
});
it('ADR0004 item signed/natural totals, zero-sum and descendant rollups', async () => {
  const summary = (await get({ group_by: 'item' }, '/summary')).json();
  const rows = summary.items as {
    id: string;
    signed_amount: string;
    natural_amount: string;
    rollup_signed_amount: string;
    rollup_natural_amount: string;
  }[];
  for (const [id, signed, natural] of [
    [cash, '33880.000000', '33880.000000'],
    [food, '720.000000', '720.000000'],
    [travel, '400.000000', '400.000000'],
    [salary, '-35000.000000', '35000.000000'],
  ])
    expect(rows.find((r) => r.id === id)).toMatchObject({
      signed_amount: signed,
      natural_amount: natural,
    });
  expect(rows.reduce((n, r) => n + moneyUnits(r.signed_amount), 0n)).toBe(0n);
  expect(rows.find((r) => r.id === expenseRoot)).toMatchObject({
    signed_amount: '0',
    rollup_signed_amount: '1120.000000',
    rollup_natural_amount: '1120.000000',
  });
  const selected = (
    await get({ group_by: 'item', item_id: food }, '/summary')
  ).json();
  expect(selected.items).toHaveLength(1);
  expect(selected.items[0]).toMatchObject({
    id: food,
    signed_amount: '720.000000',
  });
});
it('compares three AND-filter combinations with independent direct SQL counts and amount sums', async () => {
  const cases = [
    {
      q: {
        date_from: '2026-10-01',
        date_to: '2026-10-09',
        amount_min: '100',
        amount_max: '1000',
        kind: 'expense',
      },
      sql: () =>
        f.db`SELECT count(*)::int AS n,sum(x.amount)::text AS amount FROM (SELECT t.id,(SELECT sum(e.base_amount) FROM transaction_entries e WHERE e.transaction_id=t.id AND e.base_amount>0) AS amount FROM transactions t WHERE t.ledger_id=${f.ledger} AND t.occurred_on BETWEEN '2026-10-01' AND '2026-10-09' AND t.kind='expense') x WHERE x.amount BETWEEN 100 AND 1000`,
    },
    {
      q: {
        item_id: cash,
        payee_id: payee,
        project_id: project,
        keyword: 'abc',
        kind: 'expense',
      },
      sql: () =>
        f.db`SELECT count(*)::int AS n,sum(x.amount)::text AS amount FROM (SELECT t.id,(SELECT sum(e.base_amount) FROM transaction_entries e WHERE e.transaction_id=t.id AND e.base_amount>0) AS amount FROM transactions t WHERE t.ledger_id=${f.ledger} AND t.kind='expense' AND t.payee_id=${payee} AND t.project_id=${project} AND (lower(t.memo) LIKE '%abc%' OR lower(t.invoice_no) LIKE '%abc%') AND EXISTS (SELECT 1 FROM transaction_entries e WHERE e.transaction_id=t.id AND e.item_id=${cash})) x`,
    },
    {
      q: {
        item_id: foodParent,
        date_from: '2026-10-02',
        date_to: '2026-10-10',
        keyword: 'AbC',
        amount_min: '500',
        amount_max: '1000',
        kind: 'expense',
      },
      sql: () =>
        f.db`WITH RECURSIVE subtree AS (SELECT id FROM items WHERE id=${foodParent} AND ledger_id=${f.ledger} UNION ALL SELECT i.id FROM items i JOIN subtree s ON i.parent_id=s.id WHERE i.ledger_id=${f.ledger}) SELECT count(*)::int AS n,sum(x.amount)::text AS amount FROM (SELECT t.id,(SELECT sum(e.base_amount) FROM transaction_entries e WHERE e.transaction_id=t.id AND e.base_amount>0) AS amount FROM transactions t WHERE t.ledger_id=${f.ledger} AND t.kind='expense' AND t.occurred_on BETWEEN '2026-10-02' AND '2026-10-10' AND (lower(t.memo) LIKE '%abc%' OR lower(t.invoice_no) LIKE '%abc%') AND EXISTS (SELECT 1 FROM transaction_entries e WHERE e.transaction_id=t.id AND e.item_id IN (SELECT id FROM subtree))) x WHERE x.amount BETWEEN 500 AND 1000`,
    },
  ];
  for (const c of cases) {
    const [direct] = await c.sql();
    const response = await get(c.q);
    expect(response.statusCode).toBe(200);
    const data = response.json();
    expect(data.totals.count).toBe(direct!.n);
    expect(data.items).toHaveLength(direct!.n);
    expect(data.totals.by_kind).toEqual([
      { kind: 'expense', count: direct!.n, transaction_amount: direct!.amount },
    ]);
  }
});
it('keyset pages beyond100 with exact microsecond timestamps and deterministic id tie-break', async () => {
  const ledger = await ledgerService(f.db).create(f.actor, {
      name: 'Synthetic cursor ledger',
    }),
    items = itemService(f.db);
  const a = await items.create(f.actor, ledger.id, {
      name: 'A',
      kind: 'asset',
      currency: 'TWD',
    }),
    b = await items.create(f.actor, ledger.id, {
      name: 'B',
      kind: 'expense',
      currency: 'TWD',
    });
  await f.db.begin(async (sql) => {
    await sql`INSERT INTO transactions(ledger_id,occurred_on,kind,memo,created_at) SELECT ${ledger.id},'2026-12-01','expense','Synthetic cursor '||n,'2026-12-01T00:00:00.123456Z' FROM generate_series(1,127) n`;
    await sql`INSERT INTO transaction_entries(ledger_id,transaction_id,item_id,amount,currency,exchange_rate,base_amount) SELECT ${ledger.id},t.id,v.item,v.amount,'TWD',1,v.amount FROM transactions t CROSS JOIN (VALUES (${a.id}::uuid,-1),(${b.id}::uuid,1)) v(item,amount) WHERE t.ledger_id=${ledger.id}`;
    await sql`UPDATE transactions SET created_at='2026-12-01T00:00:00.123457Z' WHERE ledger_id=${ledger.id} AND memo='Synthetic cursor 1'`;
  });
  const service = queryService(f.db);
  let page = await service.search(f.actor, ledger.id, { limit: '7' });
  const first = page;
  expect(page.items[0]!.created_at).toBe('2026-12-01T00:00:00.123457Z');
  let found = page.items.map((i) => i.id);
  while (page.next_cursor) {
    page = await service.search(f.actor, ledger.id, {
      limit: '7',
      cursor: page.next_cursor,
    });
    found = found.concat(page.items.map((i) => i.id));
  }
  const expected =
    await f.db`SELECT id FROM transactions WHERE ledger_id=${ledger.id} ORDER BY occurred_on DESC,created_at DESC,id DESC`;
  expect(found).toEqual(expected.map((r) => r.id));
  expect(new Set(found).size).toBe(127);
  expect(
    (await service.search(f.actor, ledger.id, { limit: '7' })).items.map(
      (r) => r.id,
    ),
  ).toEqual(first.items.map((r) => r.id));
  expect(await service.all(f.actor, ledger.id)).toHaveLength(127);
  await expect(
    service.search(f.actor, ledger.id, {
      limit: '7',
      cursor: first.next_cursor!,
      kind: 'income',
    }),
  ).rejects.toMatchObject({ code: 'invalid_cursor' });
});
it('all query/summary/core operations and foreign filter references are owner-isolated as404', async () => {
  for (const suffix of ['', '/summary']) {
    const r = await get(
      suffix ? { group_by: 'item' } : {},
      suffix,
      f.otherHeaders,
    );
    expect(r.statusCode).toBe(404);
  }
  const [other] =
    await f.db`SELECT id FROM users WHERE oidc_issuer='https://queries.synthetic.invalid' AND oidc_subject='stranger'`;
  for (const operation of [
    () => queryService(f.db).search(String(other!.id), f.ledger, {}),
    () =>
      queryService(f.db).summary(String(other!.id), f.ledger, {
        group_by: 'month',
      }),
    () => queryService(f.db).all(String(other!.id), f.ledger, {}),
  ])
    await expect(operation()).rejects.toMatchObject({ statusCode: 404 });
  const second = await ledgerService(f.db).create(f.actor, {
    name: 'Synthetic filter ledger',
  });
  const foreign = await itemService(f.db).create(f.actor, second.id, {
    name: 'Foreign',
    kind: 'asset',
    currency: 'TWD',
  });
  expect((await get({ item_id: foreign.id })).statusCode).toBe(404);
  expect((await f.app.inject({ url: url() })).statusCode).toBe(401);
});
it('validates ranges, exact decimal strings, cursor/filter binding and literal case-insensitive keyword', async () => {
  for (const q of [
    { date_from: '2026-10-10', date_to: '2026-10-01' },
    { amount_min: '2', amount_max: '1' },
    { amount_min: 'NaN' },
    { amount_min: '1e3' },
    { amount_min: '-1' },
    { amount_min: '1.001' },
    { limit: '101' },
    { cursor: 'invalid' },
    { keyword: '%' },
  ]) {
    const r = await get(q);
    expect(r.statusCode).toBe('keyword' in q ? 200 : 400);
    if ('keyword' in q) expect(r.json().items).toEqual([]);
  }
  const first = (await get({ limit: '1' })).json();
  expect(
    (await get({ cursor: first.next_cursor, kind: 'expense' })).json(),
  ).toEqual({ error: 'invalid_cursor' });
});

it('natural directions reverse liability/equity and parent rollups while preserving signed zero', async () => {
  const l = await ledgerService(f.db).create(f.actor, {
      name: 'Synthetic natural directions',
    }),
    items = itemService(f.db);
  async function create(
    name: string,
    kind: string,
    parent_id: string | null = null,
  ) {
    return (
      await items.create(f.actor, l.id, {
        name,
        kind,
        currency: 'TWD',
        parent_id,
      })
    ).id;
  }
  const asset = await create('Bank', 'asset'),
    parent = await create('Liabilities', 'liability'),
    loan = await create('Loan', 'liability', parent),
    equity = await create('Equity', 'equity');
  for (const [a, b, amount] of [
    [loan, asset, '100'],
    [equity, asset, '50'],
    [asset, loan, '20'],
  ])
    await transactionService(f.db).create(f.actor, l.id, {
      occurred_on: '2026-11-01',
      entries: [
        { item_id: a!, amount: '-' + amount },
        { item_id: b!, amount: amount! },
      ],
    });
  const summary = await queryService(f.db).summary(f.actor, l.id, {
    group_by: 'item',
  });
  expect(summary.items.find((r) => r.id === loan)).toMatchObject({
    signed_amount: '-80.000000',
    natural_amount: '80.000000',
  });
  expect(summary.items.find((r) => r.id === equity)).toMatchObject({
    natural_amount: '50.000000',
  });
  expect(summary.items.find((r) => r.id === parent)).toMatchObject({
    rollup_signed_amount: '-80.000000',
    rollup_natural_amount: '80.000000',
  });
  expect(
    summary.items.reduce((sum, r) => sum + moneyUnits(r.signed_amount), 0n),
  ).toBe(0n);
});
it('archived filter resources remain queryable for historical transactions', async () => {
  await itemService(f.db).update(f.actor, f.ledger, foodParent, {
    archived: true,
  });
  await namedRecordService(f.db, 'payees').update(f.actor, f.ledger, payee, {
    archived: true,
  });
  await namedRecordService(f.db, 'projects').update(
    f.actor,
    f.ledger,
    project,
    { archived: true },
  );
  expect(
    (
      await get({ item_id: foodParent, payee_id: payee, project_id: project })
    ).json().totals.count,
  ).toBe(2);
});
