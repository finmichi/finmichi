// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  reportService,
  namedRecordService,
  ledgerService,
  roundHalfUp,
} from '@finmichi/core';
import type {
  ProjectReport,
  IncomeReport,
  CategoryReport,
} from '@finmichi/core/report-schemas';
import { fixture } from '../test/catalog-fixture.js';
import { seedProjects } from '../../../scripts/project-report-fixture.mjs';
let f: Awaited<ReturnType<typeof fixture>>,
  ids: Awaited<ReturnType<typeof seedProjects>>;
const dates = { date_from: '2026-09-01', date_to: '2026-10-31' };
const path = (name: string, q: Record<string, string> = {}) =>
  `/api/ledgers/${f.ledger}/reports/${name}?${new URLSearchParams({ ...dates, ...q })}`;
beforeAll(async () => {
  f = await fixture('project-report');
  ids = await seedProjects(f.db, f.actor, f.ledger);
});
afterAll(async () => {
  if (f) await f.close();
});
it('matches independently calculated P&L, inclusive days, currencies, rollup and mixed/transfer semantics', async () => {
  const res = await f.app.inject({ url: path('projects'), headers: f.headers });
  expect(res.statusCode).toBe(200);
  const r = res.json<ProjectReport>();
  expect(r.projects.map((p) => p.id).sort()).toEqual(
    [ids.trip, ids.empty].sort(),
  );
  const p = r.projects.find((p) => p.id === ids.trip)!;
  // 200 + 5000*0.2 - 500*0.2 + 120 = 1220; 200/7 is not the daily expense.
  expect(p).toMatchObject({
    income: '200.00',
    expense: '1220.00',
    net: '-1020.00',
    transaction_count: 6,
    first_on: '2026-09-30',
    last_on: '2026-10-06',
    days: 7,
    daily_average_expense: '174.29',
  });
  expect(p.currencies).toEqual([
    {
      currency: 'JPY',
      original_expense: '4500.000000',
      base_expense: '900.00',
    },
    { currency: 'TWD', original_expense: '320.000000', base_expense: '320.00' },
  ]);
  expect(p.items.find((i) => i.id === ids.ids.expense)).toMatchObject({
    own_amount: '0.00',
    rollup_amount: '1220.00',
  });
  expect(p.months).toEqual([
    { month: '2026-09', income: '0.00', expense: '200.00', net: '-200.00' },
    { month: '2026-10', income: '200.00', expense: '1020.00', net: '-820.00' },
  ]);
  expect(r.projects.find((p) => p.id === ids.empty)).toMatchObject({
    transaction_count: 0,
    income: '0.00',
    expense: '0.00',
    days: 0,
    first_on: null,
    last_on: null,
    daily_average_expense: null,
    items: [],
    currencies: [],
    months: [],
  });
  const narrow = (
    await f.app.inject({
      url: path('projects', { date_from: '2026-10-02', date_to: '2026-10-03' }),
      headers: f.headers,
    })
  )
    .json<ProjectReport>()
    .projects.find((p) => p.id === ids.trip)!;
  expect(narrow).toMatchObject({
    days: 2,
    daily_average_expense: '450.00',
    expense: '900.00',
  });
});
it('includes archived only when requested and excludes unspecified project', async () => {
  const r = await reportService(f.db).projects(f.actor, f.ledger, {
    ...dates,
    include_archived: 'true',
  });
  expect(r.projects).toHaveLength(3);
  expect(r.projects.find((p) => p.id === ids.archived)).toMatchObject({
    expense: '77.00',
    archived: true,
  });
});
it('project-filtered existing reports equal project P&L; old SQL signatures and unfiltered totals remain intact', async () => {
  const income = (
    await f.app.inject({
      url: path('income-summary', { grain: 'month', project_id: ids.trip }),
      headers: f.headers,
    })
  ).json<IncomeReport>();
  const category = (
    await f.app.inject({
      url: path('category-statistics', {
        kind: 'expense',
        project_id: ids.trip,
      }),
      headers: f.headers,
    })
  ).json<CategoryReport>();
  expect(income.totals).toMatchObject({
    income_total: '200.00',
    expense_total: '1220.00',
    net_income: '-1020.00',
  });
  expect(category.total_amount).toBe('1220.00');
  const unfiltered = await reportService(f.db).income(f.actor, f.ledger, {
    ...dates,
    grain: 'month',
  });
  expect(unfiltered.totals.expense_total).toBe('2296.00');
  const [old] =
    await f.db`SELECT report_income_summary(${f.actor},${f.ledger},'2026-09-01','2026-10-31','month') i,report_category_statistics(${f.actor},${f.ledger},'2026-09-01','2026-10-31','expense','all','all') c`;
  expect(old!.i.totals).toEqual(unfiltered.totals);
  expect(old!.c.total_amount).toBe('2296.00');
  const csv = await f.app.inject({
    url: path('income-summary.csv', { grain: 'month', project_id: ids.trip }),
    headers: f.headers,
  });
  expect(csv.statusCode).toBe(200);
  expect(csv.body).toContain('1220.00');
});
it('summary project uses the shared transaction filters and ADR0004 transaction amount', async () => {
  const url = `/api/ledgers/${f.ledger}/transactions/summary?${new URLSearchParams({ ...dates, group_by: 'project' })}`;
  const r = (await f.app.inject({ url, headers: f.headers })).json();
  expect(r.group_by).toBe('project');
  expect(r.projects).toHaveLength(2);
  const p = r.projects.find((p: { id: string }) => p.id === ids.trip);
  expect(p.count).toBe(6);
  expect(roundHalfUp(p.transaction_amount, 2)).toBe('1570.00');
  const filtered = (
    await f.app.inject({
      url: url + '&project_id=' + ids.trip,
      headers: f.headers,
    })
  ).json();
  expect(filtered.projects).toHaveLength(1);
  expect(filtered.totals.count).toBe(6);
});
it.each(['projects', 'income-summary', 'category-statistics'])(
  'isolates %s by owner and rejects foreign project refs',
  async (name) => {
    const q =
      name === 'income-summary'
        ? { grain: 'month' }
        : name === 'category-statistics'
          ? { kind: 'expense' }
          : {};
    expect(
      (await f.app.inject({ url: path(name, q), headers: f.otherHeaders }))
        .statusCode,
    ).toBe(404);
    const [sql] =
      await f.db`SELECT report_projects(${(await f.db`SELECT id FROM users WHERE id<>${f.actor} LIMIT 1`)[0]!.id},${f.ledger},'2026-09-01','2026-10-31',true) r`;
    expect(sql!.r).toBeNull();
    if (name === 'projects') return;
    const other = await ledgerService(f.db).create(f.actor, {
        name: '另一合成專案帳本 ' + name,
      }),
      p = await namedRecordService(f.db, 'projects').create(f.actor, other.id, {
        name: '不可跨帳本',
      });
    expect(
      (
        await f.app.inject({
          url: path(name, { ...q, project_id: p.id }),
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(404);
  },
);
it('rejects invalid ranges, booleans and unknown query fields', async () => {
  for (const q of [
    { date_from: '2026-11-01', date_to: '2026-10-01' },
    { include_archived: 'yes' },
    { owner_id: f.actor },
  ])
    expect(
      (await f.app.inject({ url: path('projects', q), headers: f.headers }))
        .statusCode,
    ).toBe(400);
});

it('rounds the exact rational once, including huge near-half values and negative refunds', async () => {
  const reference = (amount: string, days: number) => {
    const negative = amount.startsWith('-'),
      [whole, decimal = ''] = (negative ? amount.slice(1) : amount).split('.');
    const numerator = BigInt(whole! + decimal) * 100n,
      denominator = 10n ** BigInt(decimal.length) * BigInt(days);
    const q =
      numerator / denominator +
      (2n * (numerator % denominator) >= denominator ? 1n : 0n);
    return (
      (negative && q !== 0n ? '-' : '') +
      q / 100n +
      '.' +
      String(q % 100n).padStart(2, '0')
    );
  };
  for (const [amount, days, expected] of [
    ['1220.00', 7, '174.29'],
    ['0.01', 2, '0.01'],
    ['-0.01', 2, '-0.01'],
    ['3000000000000014999.990000', 3000000, '1000000000000.00'],
    ['-3000000000000014999.990000', 3000000, '-1000000000000.00'],
    ['3000000000000015000.000000', 3000000, '1000000000000.01'],
    ['-3000000000000015000.000000', 3000000, '-1000000000000.01'],
  ] as const) {
    expect(reference(amount, days)).toBe(expected);
    const [r] =
      await f.db`SELECT report_money_average(${amount}::numeric,${days})::text amount`;
    expect(r!.amount).toBe(expected);
  }
  const [empty] =
    await f.db`SELECT report_money_average(1,0) a,report_money_average(null,2) b`;
  expect(empty).toEqual({ a: null, b: null });
});
