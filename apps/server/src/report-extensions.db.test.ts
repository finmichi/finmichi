// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { parse } from 'csv-parse/sync';
import {
  reportService,
  itemService,
  ledgerService,
  transactionService,
} from '@finmichi/core';
import type {
  ProfitLossReport,
  AccountLedgerReport,
  NetWorthFlowReport,
} from '@finmichi/core/report-schemas';
import { fixture } from '../test/catalog-fixture.js';
import { seedReport } from '../../../scripts/report-fixture.mjs';
let f: Awaited<ReturnType<typeof fixture>>,
  ids: Awaited<ReturnType<typeof seedReport>>,
  usd: string,
  card: string;
const dates = { date_from: '2026-09-01', date_to: '2026-12-31' };
const path = (name: string, args: Record<string, string>) =>
  `/api/ledgers/${f.ledger}/reports/${name}?` + new URLSearchParams(args);
async function get<T>(
  name: string,
  args: Record<string, string>,
  other = false,
): Promise<T> {
  const r = await f.app.inject({
    url: path(name, args),
    headers: other ? f.otherHeaders : f.headers,
  });
  expect(r.statusCode).toBe(200);
  return r.json();
}
beforeAll(async () => {
  f = await fixture('report-extensions');
  ids = await seedReport(f.db, f.actor, f.ledger);
  usd = (
    await itemService(f.db).create(f.actor, f.ledger, {
      name: '合成美元',
      kind: 'asset',
      currency: 'USD',
      parent_id: ids.assets,
    })
  ).id;
  card = (
    await itemService(f.db).create(f.actor, f.ledger, {
      name: '合成負債',
      kind: 'liability',
      currency: 'TWD',
    })
  ).id;
  await transactionService(f.db).create(f.actor, f.ledger, {
    occurred_on: '2026-10-12',
    memo: '=SYNTHETIC_PRIVATE',
    entries: [
      { item_id: usd, amount: '100', exchange_rate: '32' },
      { item_id: ids.cash, amount: '-3200' },
    ],
  });
  await transactionService(f.db).create(f.actor, f.ledger, {
    occurred_on: '2026-10-13',
    entries: [
      { item_id: card, amount: '-500' },
      { item_id: ids.cash, amount: '500' },
    ],
  });
});
afterAll(async () => {
  if (f) await f.close();
});
it('P&L month/quarter/year exact equality to report1; sections, own flags, ancestors and fixed subtotals', async () => {
  for (const grain of ['month', 'quarter', 'year'] as const) {
    const r = await get<ProfitLossReport>('profit-loss', { ...dates, grain });
    const old = await reportService(f.db).income(f.actor, f.ledger, {
      ...dates,
      grain,
    });
    for (const k of ['income_total', 'expense_total', 'net_income'] as const)
      expect(r.totals[k]).toBe(old.totals[k]);
    expect(r.totals).toMatchObject({
      operating_income: '35000.00',
      non_operating_income: '50.00',
      operating_expense: '1120.00',
      non_operating_expense: '0.00',
      fixed_expense: '720.00',
      variable_expense: '400.00',
      operating_profit: '33880.00',
      net_income: '33930.00',
      operating_margin: '96.8000000000',
    });
    for (let j = 0; j < r.periods.length; j++)
      for (const k of ['income_total', 'expense_total', 'net_income'] as const)
        expect(r.periods[j]![k]).toBe(old.periods[j]![k]);
    const expense = r.sections.find((s) => s.key === 'operating_expense')!;
    expect(expense.items.map((i) => i.id).sort()).toEqual(
      [ids.expenses, ids.food, ids.travel].sort(),
    );
    expect(
      r.sections.find((s) => s.key === 'non_operating_expense')!.items,
    ).toEqual([]);
  }
  for (const fixed of ['all', 'fixed', 'variable']) {
    const r = await f.app.inject({
      url: path('profit-loss', { ...dates, grain: 'month', fixed }),
      headers: f.headers,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_input');
  }
});
it('P&L zero revenue margin null, empty nodes omitted, ten-year cap and strict input', async () => {
  const r = await get<ProfitLossReport>('profit-loss', {
    date_from: '2025-01-01',
    date_to: '2025-12-31',
    grain: 'month',
  });
  expect(r.periods).toHaveLength(12);
  expect(r.totals.operating_margin).toBeNull();
  expect(r.sections.every((s) => s.items.length === 0)).toBe(true);
  for (const args of [
    { ...dates, grain: 'day' },
    { date_from: '2020-01-01', date_to: '2030-01-01', grain: 'month' },
    { ...dates, grain: 'month', unexpected: 'x' },
  ]) {
    const r = await f.app.inject({
      url: path('profit-loss', args),
      headers: f.headers,
    });
    expect(r.statusCode).toBe(400);
  }
  expect(
    (
      await get<ProfitLossReport>('profit-loss', {
        date_from: '2020-01-01',
        date_to: '2029-12-31',
        grain: 'month',
      })
    ).periods,
  ).toHaveLength(120);
});
it('net-worth flow equity adjustment/transfer identity, sequential opening/closing and historical balance report equality', async () => {
  for (const grain of ['day', 'month', 'quarter', 'year']) {
    const r = await get<NetWorthFlowReport>('net-worth-flow', {
      ...dates,
      grain,
    });
    let prior: string | undefined;
    for (const p of r.periods) {
      expect(p.is_balanced).toBe(true);
      expect(p.identity_difference).toBe('0.00');
      if (prior !== undefined) expect(p.opening).toBe(prior);
      prior = p.closing;
      const b = await reportService(f.db).balance(f.actor, f.ledger, {
        as_of: p.date_to,
      });
      expect(p.closing).toBe(b.totals.net_worth);
    }
    expect(r.periods.at(-1)!.closing).toBe('43930.00');
  }
  const monthly = await get<NetWorthFlowReport>('net-worth-flow', {
    ...dates,
    grain: 'month',
  });
  expect(monthly.periods[0]).toMatchObject({
    equity_change: '10000.00',
    opening: '0.00',
    closing: '10000.00',
  });
  expect(monthly.periods[2]).toMatchObject({
    income: '0.00',
    expense: '0.00',
    opening: '43930.00',
    closing: '43930.00',
  });
});
it('account-ledger per-currency natural running balances, stable pages/carry, subtree, multi-entry counterpart, end matches report4', async () => {
  const args = { ...dates, item_id: ids.assets, limit: '2' };
  const all = await get<AccountLedgerReport>('account-ledger', {
    ...args,
    limit: '500',
  });
  let page = await get<AccountLedgerReport>('account-ledger', args);
  const entries = [...page.items];
  const seen = new Set<string>();
  while (page.next_cursor) {
    expect(seen.has(page.next_cursor)).toBe(false);
    seen.add(page.next_cursor);
    for (const c of page.carry) {
      const last = entries.findLast((e) => e.currency === c.currency);
      if (last) expect(c.book_balance).toBe(last.book_balance);
    }
    page = await get<AccountLedgerReport>('account-ledger', {
      ...args,
      cursor: page.next_cursor,
    });
    entries.push(...page.items);
  }
  expect(entries).toEqual(all.items);
  expect(new Set(entries.map((i) => i.entry_id)).size).toBe(entries.length);
  expect(all.items.some((i) => i.counterpart === '多筆分錄')).toBe(true);
  expect(all.items.find((i) => i.item_id === usd)).toMatchObject({
    original_balance: '100.000000',
    book_balance: '3200.00',
    inflow: '3200.00',
    outflow: '0.00',
  });
  const balance = await reportService(f.db).balance(f.actor, f.ledger, {
    as_of: dates.date_to,
  });
  const b = balance.items.find((i) => i.id === ids.assets)!;
  const cents = (x: string) => BigInt(x.replace('.', ''));
  expect(all.balances.reduce((s, i) => s + cents(i.closing_book), 0n)).toBe(
    cents(b.book_amount),
  );
  const october = await get<AccountLedgerReport>('account-ledger', {
    date_from: '2026-10-01',
    date_to: '2026-10-31',
    item_id: ids.cash,
    limit: '500',
  });
  expect(october.balances[0]!.opening_book).toBe('10000.00');
  const liability = await get<AccountLedgerReport>('account-ledger', {
    ...dates,
    item_id: card,
  });
  expect(liability.items[0]).toMatchObject({
    amount: '500.000000',
    base_amount: '500.00',
    original_balance: '500.000000',
    book_balance: '500.00',
  });
  expect(liability.balances[0]!.closing_book).toBe(
    balance.items.find((i) => i.id === card)!.book_amount,
  );
  const changed = await f.app.inject({
    url: path('account-ledger', {
      ...args,
      date_from: '2026-10-01',
      cursor: (await get<AccountLedgerReport>('account-ledger', args))
        .next_cursor!,
    }),
    headers: f.headers,
  });
  expect(changed.statusCode).toBe(400);
});
it('all new REST/CSV endpoints isolate owner and item, reject cursors/limits, preserve typed numeric and text CSV guard', async () => {
  for (const [name, args] of [
    ['profit-loss', { ...dates, grain: 'month' }],
    ['net-worth-flow', { ...dates, grain: 'month' }],
    ['account-ledger', { ...dates, item_id: ids.assets }],
  ] as const) {
    for (const suffix of ['', '.csv'])
      expect(
        (
          await f.app.inject({
            url: path(name + suffix, args),
            headers: f.otherHeaders,
          })
        ).statusCode,
      ).toBe(404);
    const csv = await f.app.inject({
      url: path(name + '.csv', args),
      headers: f.headers,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(parse(csv.body, { bom: true }).length).toBeGreaterThan(1);
  }
  const csv = await f.app.inject({
    url: path('account-ledger.csv', { ...dates, item_id: ids.assets }),
    headers: f.headers,
  });
  expect(csv.body).toContain("'=SYNTHETIC_PRIVATE");
  expect(csv.body).toContain('-3200.00');
  expect(csv.body).not.toContain("'-3200.00");
  for (const more of [{ limit: '501' }, { limit: '0' }, { cursor: 'invalid' }])
    expect(
      (
        await f.app.inject({
          url: path('account-ledger', {
            ...dates,
            item_id: ids.assets,
            ...more,
          }),
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(400);
  expect(
    (
      await f.app.inject({
        url: path('account-ledger', { ...dates, item_id: ids.food }),
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(404);
});

it('all four P&L sections use entry flags; cancellation keeps ancestors, negative margin and archived history remain exact', async () => {
  const ledger = await ledgerService(f.db).create(f.actor, {
    name: 'report sections synthetic',
  });
  const svc = itemService(f.db);
  const add = async (name: string, kind: string, flags = {}) =>
    (
      await svc.create(f.actor, ledger.id, {
        name,
        kind,
        currency: 'TWD',
        ...flags,
      })
    ).id;
  const cash = await add('合成現金', 'asset'),
    income = await add('合成收入', 'income'),
    otherIncome = await add('合成業外收入', 'income', { non_operating: true }),
    parent = await add('合成支出父', 'expense'),
    expense = await add('合成固定支出', 'expense', {
      parent_id: parent,
      fixed: true,
    }),
    refund = await add('合成退款', 'expense', { parent_id: parent }),
    other = await add('合成業外支出', 'expense', { non_operating: true });
  for (const [id, amount] of [
    [income, '-3'],
    [otherIncome, '-2'],
    [expense, '5'],
    [refund, '-5'],
    [other, '4'],
  ] as const)
    await transactionService(f.db).create(f.actor, ledger.id, {
      occurred_on: '2026-10-01',
      entries: [
        { item_id: id, amount },
        { item_id: cash, amount: String(-BigInt(amount)) },
      ],
    });
  const r = await reportService(f.db).profitLoss(f.actor, ledger.id, {
    ...dates,
    grain: 'month',
  });
  expect(r.totals).toMatchObject({
    operating_income: '3.00',
    non_operating_income: '2.00',
    operating_expense: '0.00',
    non_operating_expense: '4.00',
    fixed_expense: '5.00',
    variable_expense: '-5.00',
    net_income: '1.00',
  });
  expect(
    r.sections
      .find((s) => s.key === 'operating_expense')!
      .items.find((i) => i.id === parent)!.total,
  ).toBe('0.00');
  await transactionService(f.db).create(f.actor, ledger.id, {
    occurred_on: '2026-10-02',
    entries: [
      { item_id: expense, amount: '10' },
      { item_id: cash, amount: '-10' },
    ],
  });
  await svc.update(f.actor, ledger.id, expense, { archived: true });
  const loss = await reportService(f.db).profitLoss(f.actor, ledger.id, {
    ...dates,
    grain: 'month',
  });
  expect(loss.totals.net_income).toBe('-9.00');
  expect(loss.totals.operating_margin).toBe('-233.3333333333');
  const original = await reportService(f.db).income(f.actor, ledger.id, {
    ...dates,
    grain: 'month',
  });
  expect(loss.totals.net_income).toBe(original.totals.net_income);
});
it('account ledger empty currencies are zero; forged cursor dates/positions reject safely and an empty page preserves carry', async () => {
  const empty = (
    await itemService(f.db).create(f.actor, f.ledger, {
      name: '合成無分錄負債',
      kind: 'liability',
      currency: 'EUR',
    })
  ).id;
  const blank = await reportService(f.db).accountLedger(f.actor, f.ledger, {
    ...dates,
    item_id: empty,
  });
  expect(blank.balances).toEqual([
    {
      currency: 'EUR',
      opening_original: '0.000000',
      opening_book: '0.00',
      closing_original: '0.000000',
      closing_book: '0.00',
    },
  ]);
  const first = await reportService(f.db).accountLedger(f.actor, f.ledger, {
    ...dates,
    item_id: ids.assets,
    limit: 1,
  });
  const payload = JSON.parse(
    Buffer.from(first.next_cursor!, 'base64url').toString(),
  );
  for (const changed of [
    { entry_position: 2147483648 },
    { created_at: '2026-99-99 00:00:00+00' },
    { created_at: '2026-02-30 00:00:00+00' },
    { created_at: '0000-01-01 00:00:00+00' },
    { occurred_on: '2026-02-30' },
  ]) {
    await expect(
      reportService(f.db).accountLedger(f.actor, f.ledger, {
        ...dates,
        item_id: ids.assets,
        cursor: Buffer.from(
          JSON.stringify({ ...payload, ...changed }),
        ).toString('base64url'),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', statusCode: 400 });
  }
  const page = await reportService(f.db).accountLedger(f.actor, f.ledger, {
    ...dates,
    item_id: ids.assets,
    limit: 500,
  });
  const last = page.items.at(-1)!;
  const emptyPage = await reportService(f.db).accountLedger(f.actor, f.ledger, {
    ...dates,
    item_id: ids.assets,
    cursor: Buffer.from(
      JSON.stringify({
        ...payload,
        occurred_on: last.occurred_on,
        created_at: last.created_at,
        transaction_id: last.transaction_id,
        entry_id: last.entry_id,
        entry_position: last.entry_position,
      }),
    ).toString('base64url'),
  });
  expect(emptyPage.items).toEqual([]);
  expect(emptyPage.carry).toEqual(page.carry);
});

it('full account CSV crosses 500-entry pages without truncation and keeps stable tied creation ordering', async () => {
  const ledger = await ledgerService(f.db).create(f.actor, {
    name: 'full CSV synthetic',
  });
  const cash = (
    await itemService(f.db).create(f.actor, ledger.id, {
      name: '合成匯出現金',
      kind: 'asset',
      currency: 'TWD',
    })
  ).id;
  const income = (
    await itemService(f.db).create(f.actor, ledger.id, {
      name: '合成匯出收入',
      kind: 'income',
      currency: 'TWD',
    })
  ).id;
  for (let i = 0; i < 501; i++)
    await transactionService(f.db).create(f.actor, ledger.id, {
      occurred_on: '2026-10-01',
      memo: '=合成' + i,
      entries: [
        { item_id: cash, amount: '1' },
        { item_id: income, amount: '-1' },
      ],
    });
  await f.db`UPDATE transactions SET created_at='2026-10-01 00:00:00+00' WHERE ledger_id=${ledger.id}`;
  const input = { ...dates, item_id: cash };
  const first = await reportService(f.db).accountLedger(f.actor, ledger.id, {
    ...input,
    limit: 500,
  });
  expect(first.items).toHaveLength(500);
  expect(first.next_cursor).not.toBeNull();
  const all = await reportService(f.db).accountLedgerAll(
    f.actor,
    ledger.id,
    input,
  );
  expect(all.items).toHaveLength(501);
  expect(all.items.slice(0, 500)).toEqual(first.items);
  expect(all.carry[0]!.book_balance).toBe('501.00');
  expect(all.items.at(-1)!.book_balance).toBe('501.00');
  const response = await f.app.inject({
    url:
      `/api/ledgers/${ledger.id}/reports/account-ledger.csv?` +
      new URLSearchParams(input),
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  const rows = parse(response.body, { bom: true });
  expect(rows).toHaveLength(502);
  expect(rows[501][11]).toBe('501.00');
  expect(rows[1][1]).toMatch(/^'=合成/);
});
