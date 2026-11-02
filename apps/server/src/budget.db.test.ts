// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { parse } from 'csv-parse/sync';
import { budgetService, reportService, itemService } from '@finmichi/core';
import type { BudgetReport } from '@finmichi/core/report-schemas';
import { fixture } from '../test/catalog-fixture.js';
import { seedReport } from '../../../scripts/report-fixture.mjs';
let f: Awaited<ReturnType<typeof fixture>>,
  ids: Awaited<ReturnType<typeof seedReport>>;
beforeAll(async () => {
  f = await fixture('budget');
  ids = await seedReport(f.db, f.actor, f.ledger);
});
afterAll(async () => {
  if (f) await f.close();
});
const q = {
  year: 2026,
  grain: 'month',
  kind: 'expense',
  non_operating: 'all',
  fixed: 'all',
};
const path = (name = 'budgets') => `/api/ledgers/${f.ledger}/${name}`;
it('annual REST writes all12 exact cents, updates individual months and rejects invalid totals atomically', async () => {
  const input = { year: 2026, item_id: ids.food, total: '1000' };
  const r = await f.app.inject({
    method: 'POST',
    url: path() + '/distribute',
    headers: f.headers,
    payload: input,
  });
  expect(r.statusCode).toBe(200);
  expect(r.json().map((r: { amount: string }) => r.amount)).toEqual([
    ...Array(11).fill('83.33'),
    '83.37',
  ]);
  for (const total of ['-1', '0.001', 1]) {
    const bad = await f.app.inject({
      method: 'POST',
      url: path() + '/distribute',
      headers: f.headers,
      payload: { ...input, total },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_input');
  }
  expect(
    (await budgetService(f.db).list(f.actor, f.ledger, { year: 2026 })).at(-1)
      ?.amount,
  ).toBe('83.37');
  for (const total of ['0.06', '0.12']) {
    const r = await f.app.inject({
      method: 'POST',
      url: path() + '/distribute',
      headers: f.headers,
      payload: { ...input, total },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().at(-1).amount).toBe(total === '0.06' ? '0.06' : '0.01');
  }
  const update = await f.app.inject({
    method: 'PUT',
    url: path(),
    headers: f.headers,
    payload: {
      year: 2026,
      item_id: ids.food,
      months: [{ month: 2, amount: '55.55' }],
    },
  });
  expect(update.statusCode).toBe(200);
  expect(update.json()[1].amount).toBe('55.55');
  expect(update.json()[0].amount).toBe('0.01');
});
it('parent/child budgets roll up once, all grains/empty periods, zero denominator and signed variance', async () => {
  const b = budgetService(f.db);
  await b.distribute(f.actor, f.ledger, {
    year: 2026,
    item_id: ids.expenses,
    total: '1200',
  });
  await b.distribute(f.actor, f.ledger, {
    year: 2026,
    item_id: ids.food,
    total: '600',
  });
  await b.save(f.actor, f.ledger, {
    year: 2026,
    item_id: ids.travel,
    months: [{ month: 10, amount: '30' }],
  });
  const r = await reportService(f.db).budget(f.actor, f.ledger, q);
  expect(r.periods).toHaveLength(12);
  expect(r.totals).toEqual({
    budget_total: '1830.00',
    actual_total: '1120.00',
    variance: '-710.00',
    achievement: '61.2021857923',
  });
  const oct = r.periods[9]!;
  expect(oct.budget_total).toBe('180.00');
  expect(oct.actual_total).toBe('1120.00');
  expect(oct.items.find((i) => i.id === ids.expenses)).toMatchObject({
    budget_own: '100.00',
    budget_rollup: '180.00',
    actual_rollup: '1120.00',
    variance: '940.00',
    achievement: '622.2222222222',
  });
  expect(r.periods[0]?.actual_total).toBe('0.00');
  for (const [grain, count, total] of [
    ['quarter', 4, '480.00'],
    ['year', 1, '1830.00'],
  ] as const) {
    const v = await reportService(f.db).budget(f.actor, f.ledger, {
      ...q,
      grain,
    });
    expect(v.periods).toHaveLength(count);
    expect(v.periods.at(-1)?.budget_total).toBe(total);
    expect(v.totals).toEqual(r.totals);
  }
  const empty = await reportService(f.db).budget(f.actor, f.ledger, {
    ...q,
    year: 2025,
  });
  expect(empty.totals.achievement).toBeNull();
  expect(empty.periods.every((p) => p.items.length === 0)).toBe(true);
  await b.remove(f.actor, f.ledger, { year: 2026, item_id: ids.travel });
  const zero = await reportService(f.db).budget(f.actor, f.ledger, q);
  expect(
    zero.periods[9]?.items.find((i) => i.id === ids.travel)?.achievement,
  ).toBeNull();
  expect(
    zero.periods[9]?.items.find((i) => i.id === ids.travel)?.variance,
  ).toBe('400.00');
  await b.save(f.actor, f.ledger, {
    year: 2026,
    item_id: ids.travel,
    months: [{ month: 10, amount: '30' }],
  });
});
it('actuals equal category and income reports, own flags apply independently to budget and actual', async () => {
  const svc = reportService(f.db);
  for (const [kind, expected] of [
    ['expense', '1120.00'],
    ['income', '35050.00'],
  ] as const) {
    const r = await svc.budget(f.actor, f.ledger, { ...q, kind });
    const c = await svc.category(f.actor, f.ledger, {
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      kind,
    });
    const inc = await svc.income(f.actor, f.ledger, {
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      grain: 'month',
    });
    expect(r.totals.actual_total).toBe(expected);
    expect(r.totals.actual_total).toBe(c.total_amount);
    expect(r.totals.actual_total).toBe(
      kind === 'expense' ? inc.totals.expense_total : inc.totals.income_total,
    );
  }
  for (const [non_operating, fixed, budget, actual] of [
    ['operating', 'all', '80.00', '1120.00'],
    ['non_operating', 'all', '100.00', '0.00'],
    ['all', 'fixed', '150.00', '720.00'],
    ['all', 'variable', '30.00', '400.00'],
  ] as const) {
    const r = await svc.budget(f.actor, f.ledger, {
      ...q,
      non_operating,
      fixed,
    });
    expect(r.periods[9]).toMatchObject({
      budget_total: budget,
      actual_total: actual,
    });
  }
});
it('DB enforces income/expense and owner/ledger relationships; rollback contains no partial upserts', async () => {
  const b = budgetService(f.db);
  await expect(
    b.save(f.actor, f.ledger, {
      year: 2026,
      item_id: ids.cash,
      months: [{ month: 1, amount: '1' }],
    }),
  ).rejects.toMatchObject({ code: 'budget_item_kind_invalid' });
  await expect(
    f.db`INSERT INTO budgets(ledger_id,year,item_id,month,amount) VALUES (${f.ledger},2026,${ids.cash},1,1)`,
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    f.db`UPDATE items SET kind='asset' WHERE id=${ids.food}`,
  ).rejects.toBeTruthy();
  const before = await b.list(f.actor, f.ledger, { year: 2026 });
  const invalid = await f.app.inject({
    method: 'PUT',
    url: path(),
    headers: f.headers,
    payload: {
      year: 2026,
      item_id: ids.food,
      months: [
        { month: 1, amount: '2' },
        { month: 13, amount: '3' },
      ],
    },
  });
  expect(invalid.statusCode).toBe(400);
  expect(await b.list(f.actor, f.ledger, { year: 2026 })).toEqual(before);
});
it('all read/mutation/report/CSV endpoints isolate owners with404, require Origin/session and strict fields', async () => {
  for (const [method, url, payload] of [
    ['GET', path() + '?year=2026', undefined],
    [
      'PUT',
      path(),
      { year: 2026, item_id: ids.food, months: [{ month: 1, amount: '1' }] },
    ],
    [
      'POST',
      path() + '/distribute',
      { year: 2026, item_id: ids.food, total: '1000' },
    ],
    ['DELETE', path() + '?year=2026&item_id=' + ids.food, undefined],
    [
      'GET',
      path('reports/budget-vs-actual') + '?year=2026&grain=year&kind=expense',
      undefined,
    ],
    [
      'GET',
      path('reports/budget-vs-actual.csv') +
        '?year=2026&grain=year&kind=expense',
      undefined,
    ],
  ] as const) {
    const r = await f.app.inject({
      method,
      url,
      headers: f.otherHeaders,
      ...(payload ? { payload } : {}),
    });
    expect(r.statusCode).toBe(404);
  }
  expect((await f.app.inject({ url: path() + '?year=2026' })).statusCode).toBe(
    401,
  );
  expect(
    (
      await f.app.inject({
        method: 'PUT',
        url: path(),
        headers: { ...f.headers, origin: 'https://cross.invalid' },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        url: path() + '?year=2026&unknown=1',
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(400);
  const [r] =
    await f.db`SELECT report_budget_vs_actual(${(await f.db`SELECT id FROM users WHERE oidc_subject='stranger' AND oidc_issuer='https://budget.synthetic.invalid'`)[0]!.id},${f.ledger},2026,'year','expense','all','all') r`;
  expect(r?.r).toBeNull();
});
it('CSV typed numeric/BOM matches REST, guards user names and audit never includes financial payload', async () => {
  const guarded = await itemService(f.db).create(f.actor, f.ledger, {
    name: '=BUDGET_PRIVATE',
    kind: 'expense',
    currency: 'TWD',
    parent_id: ids.expenses,
  });
  await budgetService(f.db).save(f.actor, f.ledger, {
    year: 2026,
    item_id: guarded.id,
    months: [{ month: 10, amount: '987654.32' }],
  });
  const url = path('reports/budget-vs-actual'),
    args = '?year=2026&grain=year&kind=expense';
  const r = await f.app.inject({ url: url + args, headers: f.headers }),
    csv = await f.app.inject({ url: url + '.csv' + args, headers: f.headers });
  expect(r.statusCode).toBe(200);
  expect(csv.statusCode).toBe(200);
  expect(csv.body.charCodeAt(0)).toBe(0xfeff);
  const rows = parse(csv.body, { bom: true }) as string[][];
  expect(rows.some((x) => x.includes("'=BUDGET_PRIVATE"))).toBe(true);
  expect(rows.some((x) => x.includes('-987654.32'))).toBe(true);
  const totals = r.json<BudgetReport>().totals;
  expect(rows.at(-1)?.slice(-4)).toEqual([
    totals.budget_total,
    totals.actual_total,
    totals.variance,
    totals.achievement,
  ]);
  const logs =
    await f.db`SELECT row_to_json(a)::text body FROM audit_logs a WHERE user_id=${f.actor} AND action LIKE 'budget.%'`;
  expect(logs.some((r) => JSON.parse(r.body).action === 'budget.update')).toBe(
    true,
  );
  expect(logs.some((r) => JSON.parse(r.body).action === 'budget.delete')).toBe(
    true,
  );
  expect(JSON.stringify(logs)).not.toMatch(
    /987654|BUDGET_PRIVATE|item_id|months/,
  );
});
