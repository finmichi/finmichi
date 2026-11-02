// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { parse } from 'csv-parse/sync';
import {
  itemService,
  ledgerService,
  transactionService,
  reportService,
  sessionService,
  roundHalfUp,
} from '@finmichi/core';
import type { CategoryReport } from '@finmichi/core/report-schemas';
import { fixture } from '../test/catalog-fixture.js';
import { seedReport } from '../../../scripts/report-fixture.mjs';
let f: Awaited<ReturnType<typeof fixture>>,
  ids: Awaited<ReturnType<typeof seedReport>>;
const params = {
  date_from: '2026-10-01',
  date_to: '2026-10-31',
  kind: 'expense',
  non_operating: 'all',
  fixed: 'all',
};
const path = (q: Record<string, string>, suffix = '') =>
  `/api/ledgers/${f.ledger}/reports/category-statistics${suffix}?${new URLSearchParams(q)}`;
function scaled(value: string, places: number): bigint {
  const negative = value.startsWith('-');
  const [a, b = ''] = (negative ? value.slice(1) : value).split('.');
  return (
    (negative ? -1n : 1n) *
    (BigInt(a!) * 10n ** BigInt(places) + BigInt(b.padEnd(places, '0')))
  );
}
beforeAll(async () => {
  f = await fixture('report-category');
  ids = await seedReport(f.db, f.actor, f.ledger);
});
afterAll(async () => {
  if (f) await f.close();
});
it('ADR0005 T0–T5 expense tree, rollup, flags on own accounts and archived history', async () => {
  const response = await f.app.inject({
    url: path(params),
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  const r = response.json<CategoryReport>();
  expect(r.total_amount).toBe('1120.00');
  expect(r.root_amount).toBe('1120.00');
  expect(r.root_total_matches).toBe(true);
  expect(r.root_percentage_sum).toBe('100.0000000000');
  expect(r.pie_available).toBe(true);
  const food = r.items.find((i) => i.id === ids.food)!,
    travel = r.items.find((i) => i.id === ids.travel)!,
    root = r.items.find((i) => i.id === ids.expenses)!;
  expect(food).toMatchObject({
    own_amount: '720.00',
    rollup_amount: '720.00',
    percentage: '64.2857142857',
  });
  expect(roundHalfUp(food.percentage!, 2)).toBe('64.29');
  expect(travel.percentage).toBe('35.7142857143');
  expect(roundHalfUp(travel.percentage!, 2)).toBe('35.71');
  expect(root).toMatchObject({
    own_amount: '0.00',
    rollup_amount: '1120.00',
    non_operating: true,
    fixed: true,
  });
  expect(r.bars.map((b) => b.id)).toEqual([ids.food, ids.travel]);
  const service = reportService(f.db);
  expect(
    (
      await service.category(f.actor, f.ledger, {
        ...params,
        non_operating: 'operating',
      })
    ).total_amount,
  ).toBe('1120.00');
  const nonop = await service.category(f.actor, f.ledger, {
    ...params,
    non_operating: 'non_operating',
  });
  expect(nonop.total_amount).toBe('0.00');
  expect(nonop.items).toEqual([]);
  const fixed = await service.category(f.actor, f.ledger, {
    ...params,
    fixed: 'fixed',
  });
  expect(fixed.total_amount).toBe('720.00');
  expect(fixed.items.map((i) => i.id)).toContain(ids.expenses);
  expect(fixed.items.map((i) => i.id)).not.toContain(ids.travel);
  expect(
    (
      await service.category(f.actor, f.ledger, {
        ...params,
        fixed: 'variable',
      })
    ).total_amount,
  ).toBe('400.00');
  expect(
    (
      await service.category(f.actor, f.ledger, {
        ...params,
        kind: 'income',
        non_operating: 'non_operating',
      })
    ).total_amount,
  ).toBe('50.00');
  await itemService(f.db).update(f.actor, f.ledger, ids.food, {
    archived: true,
  });
  expect(
    (await service.category(f.actor, f.ledger, params)).items.find(
      (i) => i.id === ids.food,
    )?.archived,
  ).toBe(true);
  const [sql] =
    await f.db`SELECT report_category_statistics(${f.actor},${f.ledger},'2026-10-01','2026-10-31','expense','all','all') AS report`;
  expect(sql!.report.total_amount).toBe('1120.00');
});
it.each([
  {
    label: 'positive',
    amounts: ['720', '400'],
    total: '1120.00',
    percentages: ['64.2857142857', '35.7142857143'],
    sum: '100.0000000000',
    pie: true,
    reason: null,
  },
  {
    label: 'positive-negative',
    amounts: ['150', '-50'],
    total: '100.00',
    percentages: ['150.0000000000', '-50.0000000000'],
    sum: '100.0000000000',
    pie: false,
    reason: 'negative_items',
  },
  {
    label: 'zero',
    amounts: ['10', '-10'],
    total: '0.00',
    percentages: [null, null],
    sum: null,
    pie: false,
    reason: 'zero_total',
  },
  {
    label: 'negative',
    amounts: ['-2', '1'],
    total: '-1.00',
    percentages: [null, null],
    sum: null,
    pie: false,
    reason: 'negative_total',
  },
  {
    label: 'thirds',
    amounts: ['1', '1', '1'],
    total: '3.00',
    percentages: ['33.3333333333', '33.3333333333', '33.3333333333'],
    sum: '99.9999999999',
    pie: true,
    reason: null,
  },
  {
    label: 'signed-thirds',
    amounts: ['2', '2', '-1'],
    total: '3.00',
    percentages: ['66.6666666667', '66.6666666667', '-33.3333333333'],
    sum: '100.0000000001',
    pie: false,
    reason: 'negative_items',
  },
])(
  'rev1.2 $label percentages, exact amount identity, tolerance and CSV null/numeric provenance',
  async (c) => {
    const ledger = (
      await ledgerService(f.db).create(f.actor, { name: '合成分類-' + c.label })
    ).id;
    const items = itemService(f.db),
      cash = (
        await items.create(f.actor, ledger, {
          name: '合成現金',
          kind: 'asset',
          currency: 'TWD',
        })
      ).id,
      entryIds: string[] = [];
    for (const [index, amount] of c.amounts.entries()) {
      const id = (
        await items.create(f.actor, ledger, {
          name: '=分類' + String.fromCharCode(65 + index),
          kind: 'expense',
          currency: 'TWD',
        })
      ).id;
      entryIds.push(id);
      await transactionService(f.db).create(f.actor, ledger, {
        occurred_on: '2026-10-01',
        entries: [
          { item_id: id, amount },
          {
            item_id: cash,
            amount: amount.startsWith('-') ? amount.slice(1) : '-' + amount,
          },
        ],
      });
    }
    const report = await reportService(f.db).category(f.actor, ledger, params);
    expect(report.total_amount).toBe(c.total);
    expect(report.root_amount).toBe(c.total);
    expect(report.root_total_matches).toBe(true);
    expect(report.pie_available).toBe(c.pie);
    expect(report.pie_reason).toBe(c.reason);
    expect(report.root_percentage_sum).toBe(c.sum);
    expect(
      entryIds.map((id) => report.items.find((i) => i.id === id)?.percentage),
    ).toEqual(c.percentages);
    expect(
      report.pie.reduce((sum, i) => sum + scaled(i.rollup_amount, 2), 0n),
    ).toBe(scaled(report.total_amount, 2));
    if (c.sum !== null) {
      const sum = report.pie.reduce(
        (sum, i) => sum + scaled(i.percentage!, 10),
        0n,
      );
      const error = sum - 100n * 10n ** 10n;
      expect(error < 0n ? -error : error).toBeLessThanOrEqual(
        BigInt(report.root_count),
      );
      expect(report.percentage_sum_within_tolerance).toBe(true);
    } else {
      expect(report.items.every((i) => i.percentage === null)).toBe(true);
      expect(report.percentage_sum_within_tolerance).toBeNull();
    }
    expect(
      report.bars.every(
        (i) =>
          scaled(i.chart_weight, 10) <= 100n * 10n ** 10n &&
          scaled(i.chart_weight, 10) >= -100n * 10n ** 10n,
      ),
    ).toBe(true);
    const csv = await f.app.inject({
      url: `/api/ledgers/${ledger}/reports/category-statistics.csv?${new URLSearchParams(params)}`,
      headers: f.headers,
    });
    expect(csv.statusCode).toBe(200);
    expect([...csv.rawPayload.subarray(0, 3)]).toEqual([239, 187, 191]);
    const rows = parse(csv.body, { bom: true, cast: false }) as string[][];
    for (const [index, percentage] of c.percentages.entries()) {
      const row = rows.find(
        (r) => r[6] === "'=分類" + String.fromCharCode(65 + index),
      )!;
      expect(row[10]).toBe(percentage ?? '');
      expect(row[9]).toMatch(/^-?\d+(?:\.\d+)?$/);
    }
  },
);
it('zero-rollup ancestors remain, subtree own flags, and top10 absolute sorting with deterministic ties', async () => {
  const ledger = (
    await ledgerService(f.db).create(f.actor, { name: '合成前十與祖先' })
  ).id;
  const items = itemService(f.db),
    root = (
      await items.create(f.actor, ledger, {
        name: '合成零小計根',
        kind: 'expense',
        currency: 'TWD',
      })
    ).id,
    cash = (
      await items.create(f.actor, ledger, {
        name: '合成cash',
        kind: 'asset',
        currency: 'TWD',
      })
    ).id;
  for (const [name, amount] of [
    ['A', '10'],
    ['B', '-10'],
  ] as const) {
    const id = (
      await items.create(f.actor, ledger, {
        name,
        kind: 'expense',
        currency: 'TWD',
        parent_id: root,
      })
    ).id;
    await transactionService(f.db).create(f.actor, ledger, {
      occurred_on: '2026-10-01',
      entries: [
        { item_id: id, amount },
        {
          item_id: cash,
          amount: amount.startsWith('-') ? amount.slice(1) : '-' + amount,
        },
      ],
    });
  }
  const zero = await reportService(f.db).category(f.actor, ledger, params);
  expect(zero.items.find((i) => i.id === root)?.rollup_amount).toBe('0.00');
  expect(zero.items).toHaveLength(3);
  expect(zero.bars.map((i) => i.name)).toEqual(['A', 'B']);
  for (let n = 1; n <= 11; n++) {
    const amount = n === 11 ? '-100' : String(n),
      id = (
        await items.create(f.actor, ledger, {
          name: 'Leaf' + String(n).padStart(2, '0'),
          kind: 'expense',
          currency: 'TWD',
        })
      ).id;
    await transactionService(f.db).create(f.actor, ledger, {
      occurred_on: '2026-10-01',
      entries: [
        { item_id: id, amount },
        {
          item_id: cash,
          amount: amount.startsWith('-') ? amount.slice(1) : '-' + amount,
        },
      ],
    });
  }
  const r = await reportService(f.db).category(f.actor, ledger, params);
  expect(r.bars).toHaveLength(10);
  expect(r.bars[0]!.name).toBe('Leaf11');
  expect(r.bars[0]!.rollup_amount).toBe('-100.00');
  expect(r.bars.slice(1, 4).map((i) => i.name)).toEqual(['A', 'B', 'Leaf10']);
});
it('SQL percentage exact HALF_UP ties and owner/parameter isolation', async () => {
  const [ties] =
    await f.db`SELECT report_percentage(1,2000000000000)::text AS positive,report_percentage(-1,2000000000000)::text AS negative,report_percentage(1,0) AS zero`;
  expect(ties).toEqual({
    positive: '0.0000000001',
    negative: '-0.0000000001',
    zero: null,
  });
  const other = (await sessionService(f.db, ['owner', 'stranger']).authenticate(
    f.otherHeaders.cookie.slice(8),
  ))!.id;
  for (const suffix of ['', '.csv']) {
    expect(
      (
        await f.app.inject({
          url: path({ ...params, kind: 'bad' }, suffix),
          headers: f.otherHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect((await f.app.inject({ url: path(params, suffix) })).statusCode).toBe(
      401,
    );
  }
  await expect(
    reportService(f.db).category(other, f.ledger, {}),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(
    (
      await f.db`SELECT report_category_statistics(${other},${f.ledger},'2026-10-01','2026-10-31','expense','all','all') AS report`
    )[0]!.report,
  ).toBeNull();
  for (const q of [
    { ...params, kind: 'asset' },
    { ...params, date_from: 'bad' },
    { ...params, date_from: '2026-11-01' },
    { ...params, fixed: 'no' },
    { ...params, non_operating: 'no' },
  ])
    expect(
      (await f.app.inject({ url: path(q), headers: f.headers })).statusCode,
    ).toBe(400);
});
