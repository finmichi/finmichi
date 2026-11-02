// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readBundle } from './bundle.js';
import { mappingSchema, planSchema } from './schema.js';
import { transform } from './transform.js';
import { sumMoney } from '@finmichi/core';
async function source() {
  const b = await readBundle(
    fileURLToPath(new URL('../fixtures/', import.meta.url)),
  );
  for (const row of b.tables.get('ITEM_DATA')!) row.BEFORE_MOUNT = '0';
  b.tables.set('MYMONEY_DATA', [
    {
      DATA_KEY: 'rate',
      DATA_DATE: '2026/01/02',
      ITEM_CLASS: '資產',
      ITEM_NOTE: '美元帳戶',
      IN_MOUNT: '0',
      OUT_MOUNT: '100',
      EXCHANGE: '0.21',
    },
    {
      DATA_KEY: 'rate',
      DATA_DATE: '2026/01/02',
      ITEM_CLASS: '支出',
      ITEM_NOTE: '餐費',
      IN_MOUNT: '21',
      OUT_MOUNT: '0',
      EXCHANGE: '0.21',
    },
  ]);
  return b;
}
it('ADR8 §6.4: base 0.21 is ignored, foreign 0.21 used, C remains exact', async () => {
  const p = transform(await source(), mappingSchema.parse({}), null);
  expect(p.report.errors).toEqual([]);
  expect(p.transactions).toHaveLength(1);
  const t = p.transactions[0]!;
  expect(t.entries[0]).toMatchObject({
    amount: '-100.000000',
    exchange_rate: '0.2100000000',
    base_amount: '-21.00',
  });
  expect(t.entries[1]).toMatchObject({
    amount: '21.000000',
    exchange_rate: '1.0000000000',
    base_amount: '21.00',
  });
  expect(sumMoney(t.entries.map((e) => e.base_amount))).toBe('0.000000');
  expect(p.report.warning_counts.source_rate_ignored_base_leg).toBe(1);
  expect(p.report.warning_details).toContainEqual({
    code: 'source_rate_ignored_base_leg',
    table: 'MYMONEY_DATA',
    row: 2,
    key: 'rate',
  });
  expect(planSchema.safeParse(p).success).toBe(true);
});
it('foreign source rate 1 is used and counted, never guessed or repaired', async () => {
  const b = await source();
  b.tables.get('MYMONEY_DATA')![0]!.EXCHANGE = '1';
  b.tables.get('MYMONEY_DATA')![1]!.IN_MOUNT = '100';
  const p = transform(b, mappingSchema.parse({}), null);
  expect(p.report.errors).toEqual([]);
  expect(p.report.warning_counts.foreign_leg_rate_one).toBe(1);
  expect(p.transactions[0]!.entries[0]).toMatchObject({
    exchange_rate: '1.0000000000',
    base_amount: '-100.00',
  });
});
it('base reference rates, including malformed values, cannot become fatal; canonical 1 is not warned', async () => {
  for (const [value, count] of [
    ['0.21', 1],
    ['NaN', 1],
    ['0', 1],
    ['-2', 1],
    ['1.0000', 0],
    ['', 0],
  ] as const) {
    const b = await source();
    b.tables.get('MYMONEY_DATA')![1]!.EXCHANGE = value;
    const p = transform(b, mappingSchema.parse({}), null);
    expect(p.report.errors, value).toEqual([]);
    expect(
      p.report.warning_counts.source_rate_ignored_base_leg ?? 0,
      value,
    ).toBe(count);
    expect(p.transactions[0]!.entries[1]!.exchange_rate).toBe('1.0000000000');
  }
});
it('all staging original numeric/date/currency strings survive, and parsing issues are only staging warnings', async () => {
  const b = await source();
  const stocks = b.tables.get('STOCK_DATA')![0]!;
  stocks.INOUT_PRICE = '1.234567';
  stocks.INOUT_DATE = 'not-a-date';
  stocks.INOUT_CHARGE = 'NaN';
  const price = b.tables.get('STOCK_ID_DATA')![0]!;
  price.NOW_PRICE = '1.234567890123456789';
  const deposit = b.tables.get('REGULAR_DATA')![0]!;
  deposit.CURRENCY_NOTE = '合成未知幣別';
  deposit.SAVE_MOUNT = 'not-money';
  b.tables.set('OTHER_P3_TABLE', [
    { AMOUNT: 'NaN', DATA_DATE: 'not-a-date', PRICE: '0.1234567890123456789' },
  ]);
  const p = transform(b, mappingSchema.parse({}), null);
  expect(p.report.errors).toEqual([]);
  expect(p.report.skipped).toEqual([]);
  for (const table of [
    'STOCK_DATA',
    'STOCK_ID_DATA',
    'REGULAR_DATA',
    'OTHER_P3_TABLE',
  ])
    for (const [key, value] of Object.entries(b.tables.get(table)![0]!))
      expect(p.staging[table]![0]![key]).toBe(value);
  expect(p.report.warnings).toContain('staging_precision_exceeds_supported');
  expect(p.report.warnings).toContain('staging_invalid_amount');
  expect(p.report.warnings).toContain('staging_invalid_date');
  expect(p.report.warnings).toContain('staging_unknown_currency');
  expect(p.report.warning_counts.staging_precision_exceeds_supported).toBe(1);
  expect(
    p.report.warning_details
      .filter((w) => w.table !== 'MYMONEY_DATA')
      .every((w) => w.code.startsWith('staging_')),
  ).toBe(true);
});
it('booked amounts/currency/rates remain fatal even alongside staging warnings', async () => {
  const b = await source();
  b.tables.get('MYMONEY_DATA')![0]!.IN_MOUNT = 'NaN';
  b.tables.get('REGULAR_DATA')![0]!.CURRENCY_NOTE = '合成未知幣別';
  b.tables.get('CURRENCY_SET')![0]!.CURRENCY_EXCHANGE = 'not-rate';
  const p = transform(b, mappingSchema.parse({}), null);
  expect(p.report.errors).toContainEqual(
    expect.objectContaining({ code: 'invalid_amount', table: 'MYMONEY_DATA' }),
  );
  expect(p.report.errors).toContainEqual(
    expect.objectContaining({ code: 'invalid_rate', table: 'CURRENCY_SET' }),
  );
  expect(p.report.warning_counts.staging_unknown_currency).toBe(1);
  expect(p.transactions).toHaveLength(0);
});
