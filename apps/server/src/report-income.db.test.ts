// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { parse } from 'csv-parse/sync';
import {
  itemService,
  ledgerService,
  transactionService,
  reportService,
  sessionService,
  moneyUnits,
} from '@finmichi/core';
import type { IncomeReport } from '@finmichi/core/report-schemas';
import { fixture } from '../test/catalog-fixture.js';
import { seedReport } from '../../../scripts/report-fixture.mjs';
let f: Awaited<ReturnType<typeof fixture>>;
const query = (q: Record<string, string>, suffix = '') =>
  `/api/ledgers/${f.ledger}/reports/income-summary${suffix}?${new URLSearchParams(q)}`;
const params = {
  date_from: '2026-09-30',
  date_to: '2026-11-30',
  grain: 'month',
};
beforeAll(async () => {
  f = await fixture('report-income');
  await seedReport(f.db, f.actor, f.ledger);
});
afterAll(async () => {
  if (f) await f.close();
});
it('ADR0005 T0–T5 month summary distinguishes own flags, zeros, equity and transfers', async () => {
  const response = await f.app.inject({
    url: query(params),
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  const r = response.json<IncomeReport>();
  expect(r.periods.map((b) => b.label)).toEqual([
    '2026-09',
    '2026-10',
    '2026-11',
  ]);
  expect(r.periods[1]).toMatchObject({
    operating_income: '35000.00',
    non_operating_income: '50.00',
    operating_expense: '1120.00',
    non_operating_expense: '0.00',
    income_total: '35050.00',
    expense_total: '1120.00',
    net_income: '33930.00',
  });
  for (const b of [r.periods[0]!, r.periods[2]!])
    for (const k of Object.keys(r.totals) as (keyof typeof r.totals)[])
      expect(b[k]).toBe('0.00');
  expect(r.totals.net_income).toBe('33930.00');
  expect(r.periods[0]!.date_from).toBe('2026-09-30');
  expect(r.periods[0]!.date_to).toBe('2026-09-30');
  for (const k of Object.keys(r.totals) as (keyof typeof r.totals)[])
    expect(r.periods.reduce((sum, b) => sum + moneyUnits(b[k]), 0n)).toBe(
      moneyUnits(r.totals[k]),
    );
  const [sql] =
    await f.db`SELECT report_income_summary(${f.actor},${f.ledger},'2026-09-30','2026-11-30','month') AS report`;
  expect(sql!.report.totals).toEqual(r.totals);
});
it('calendar day/quarter/year, partial boundaries, negative net and mixed transaction kinds use entry kinds', async () => {
  const ledger = (
    await ledgerService(f.db).create(f.actor, { name: '合成日曆期間' })
  ).id;
  const items = itemService(f.db),
    ids: Record<string, string> = {};
  for (const [key, kind, non_operating] of [
    ['cash', 'asset', false],
    ['income', 'income', false],
    ['expense', 'expense', false],
    ['nonop', 'expense', true],
  ] as const)
    ids[key] = (
      await items.create(f.actor, ledger, {
        name: key,
        kind,
        currency: 'TWD',
        non_operating,
      })
    ).id;
  const tx = transactionService(f.db);
  for (const [date, legs] of [
    [
      '2025-12-31',
      [
        ['income', '-10'],
        ['cash', '10'],
      ],
    ],
    [
      '2026-01-01',
      [
        ['expense', '3'],
        ['cash', '-3'],
      ],
    ],
    [
      '2026-03-31',
      [
        ['nonop', '2'],
        ['cash', '-2'],
      ],
    ],
    [
      '2026-04-01',
      [
        ['income', '-20'],
        ['expense', '4'],
        ['cash', '16'],
      ],
    ],
  ] as [string, [string, string][]][])
    await tx.create(f.actor, ledger, {
      occurred_on: date,
      entries: legs.map(([key, amount]) => ({ item_id: ids[key], amount })),
    });
  const service = reportService(f.db),
    range = { date_from: '2025-12-31', date_to: '2026-04-01' };
  const q = await service.income(f.actor, ledger, {
    ...range,
    grain: 'quarter',
  });
  expect(q.periods.map((b) => b.label)).toEqual([
    '2025-Q4',
    '2026-Q1',
    '2026-Q2',
  ]);
  expect(q.periods.map((b) => b.net_income)).toEqual([
    '10.00',
    '-5.00',
    '16.00',
  ]);
  expect(q.periods[1]!.non_operating_expense).toBe('2.00');
  expect(q.totals).toMatchObject({
    income_total: '30.00',
    expense_total: '9.00',
    net_income: '21.00',
  });
  const y = await service.income(f.actor, ledger, { ...range, grain: 'year' });
  expect(y.periods.map((b) => b.net_income)).toEqual(['10.00', '11.00']);
  const days = await service.income(f.actor, ledger, {
    date_from: '2026-03-30',
    date_to: '2026-04-02',
    grain: 'day',
  });
  expect(days.periods.map((b) => b.net_income)).toEqual([
    '0.00',
    '-2.00',
    '16.00',
    '0.00',
  ]);
  const leap = await service.income(f.actor, ledger, {
    date_from: '2028-02-28',
    date_to: '2028-03-01',
    grain: 'day',
  });
  expect(leap.periods.map((b) => b.label)).toEqual([
    '2028-02-28',
    '2028-02-29',
    '2028-03-01',
  ]);
  expect(leap.periods.every((b) => b.net_income === '0.00')).toBe(true);
  const csv = await f.app.inject({
    url: `/api/ledgers/${ledger}/reports/income-summary.csv?${new URLSearchParams({ ...range, grain: 'quarter' })}`,
    headers: f.headers,
  });
  const rows = parse(csv.body, { bom: true, cast: false }) as string[][];
  expect(rows.some((r) => r[4] === '2026-Q1' && r[13] === '-5.00')).toBe(true);
});
it('income report and CSV enforce owner 404 and strict period parameters; numeric metadata remain strings', async () => {
  const other = (await sessionService(f.db, ['owner', 'stranger']).authenticate(
    f.otherHeaders.cookie.slice(8),
  ))!.id;
  for (const suffix of ['', '.csv']) {
    expect(
      (
        await f.app.inject({
          url: query({ ...params, grain: 'bad' }, suffix),
          headers: f.otherHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await f.app.inject({ url: query(params, suffix) })).statusCode,
    ).toBe(401);
  }
  await expect(
    reportService(f.db).income(other, f.ledger, {}),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(
    (
      await f.db`SELECT report_income_summary(${other},${f.ledger},'2026-10-01','2026-10-31','month') AS report`
    )[0]!.report,
  ).toBeNull();
  for (const q of [
    { ...params, grain: 'week' },
    { ...params, date_from: '2026-12-01' },
    { ...params, date_to: 'bad' },
    { ...params, kind: 'income' },
  ])
    expect(
      (await f.app.inject({ url: query(q), headers: f.headers })).statusCode,
    ).toBe(400);
  const response = await f.app.inject({
    url: query(params, '.csv'),
    headers: f.headers,
  });
  expect([...response.rawPayload.subarray(0, 3)]).toEqual([239, 187, 191]);
  expect(response.body).toContain('\r\n');
  const rows = parse(response.body, { bom: true, cast: false }) as string[][];
  expect(rows.some((r) => r[4] === '期間合計' && r[13] === '33930.00')).toBe(
    true,
  );
});

it.each(['day', 'month', 'quarter', 'year'] as const)(
  'income %s calendar buckets allow 1000 and reject 1001 before allocation',
  async (grain) => {
    const start = '2000-02-15';
    const ends = {
      day: ['2002-11-10', '2002-11-11'],
      month: ['2083-05-31', '2083-06-01'],
      quarter: ['2249-12-31', '2250-01-01'],
      year: ['2999-12-31', '3000-01-01'],
    }[grain];
    const allowed = { date_from: start, date_to: ends[0]!, grain };
    const accepted = await f.app.inject({
      url: query(allowed),
      headers: f.headers,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<IncomeReport>().periods).toHaveLength(1000);
    const rejected = { ...allowed, date_to: ends[1]! };
    for (const suffix of ['', '.csv']) {
      const response = await f.app.inject({
        url: query(rejected, suffix),
        headers: f.headers,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'period_range_too_large' });
      expect(
        (
          await f.app.inject({
            url: query(rejected, suffix),
            headers: f.otherHeaders,
          })
        ).statusCode,
      ).toBe(404);
    }
    await expect(
      f.db`SELECT report_income_summary(${f.actor},${f.ledger},${start}::text::date,${ends[1]!}::text::date,${grain})`,
    ).rejects.toMatchObject({
      code: 'P0001',
      message: 'period_range_too_large',
    });
  },
);
it('large historical day range is rejected and foreign owner SQL stays null', async () => {
  const q = { date_from: '1900-01-01', date_to: '2100-12-31', grain: 'day' };
  await expect(
    reportService(f.db).income(f.actor, f.ledger, q),
  ).rejects.toMatchObject({ code: 'period_range_too_large', statusCode: 400 });
  const [r] =
    await f.db`SELECT report_income_summary('00000000-0000-4000-8000-000000000000',${f.ledger},'1900-01-01','2100-12-31','day') AS report`;
  expect(r!.report).toBeNull();
});
