// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readBundle } from './bundle.js';
import { mappingSchema } from './schema.js';
import { transform } from './transform.js';
import { validatedPlan } from './import.js';
import { sumMoney } from '@finmichi/core';
const fixture = fileURLToPath(new URL('../fixtures/', import.meta.url));
async function source() {
  const b = await readBundle(fixture);
  b.tables.set('ITEM_DATA', [
    {
      ITEM_CLASS: '資產',
      ITEM_NOTE: '合成外幣戶',
      EXCHANGE_NOTE: '',
      EXCHANGE: '0.21',
      BEFORE_MOUNT: '100',
    },
    {
      ITEM_CLASS: '資產',
      ITEM_NOTE: '合成台幣戶',
      EXCHANGE_NOTE: '台幣',
      EXCHANGE: '1',
      BEFORE_MOUNT: '0',
    },
  ]);
  b.tables.set('MYMONEY_DATA', [
    {
      DATA_KEY: 'synthetic-fx',
      DATA_DATE: '2026/01/02',
      ITEM_CLASS: '資產',
      ITEM_NOTE: '合成外幣戶',
      IN_MOUNT: '0',
      OUT_MOUNT: '100',
      EXCHANGE: '0.21',
    },
    {
      DATA_KEY: 'synthetic-fx',
      DATA_DATE: '2026/01/02',
      ITEM_CLASS: '資產',
      ITEM_NOTE: '合成台幣戶',
      IN_MOUNT: '21',
      OUT_MOUNT: '0',
      EXCHANGE: '1',
    },
  ]);
  return b;
}
const explicit = (currency: string) =>
  mappingSchema.parse({
    item_currencies: [
      { item_class: '資產', item_note: '合成外幣戶', currency },
    ],
  });
it('ADR8 §8.3: base-resolved asset/liability with nonunit item rate is fatal; report exact pair and count', async () => {
  for (const kind of ['資產', '負債']) {
    const b = await source();
    b.tables.get('ITEM_DATA')![0]!.ITEM_CLASS = kind;
    const p = transform(b, mappingSchema.parse({}), null);
    expect(p.report.errors).toContainEqual({
      code: 'ambiguous_item_currency',
      table: 'ITEM_DATA',
      row: 1,
      key: JSON.stringify([kind, '合成外幣戶']),
      count: 1,
    });
    expect(() => validatedPlan(p)).toThrow('import_has_errors');
  }
});
it('explicit JPY beats EXCHANGE_NOTE including unknown/global mapping; both transfer and opening balance', async () => {
  for (const note of ['', '未知合成別名', '美元']) {
    const b = await source();
    b.tables.get('ITEM_DATA')![0]!.EXCHANGE_NOTE = note;
    const mapping = mappingSchema.parse({
      ...explicit('JPY'),
      currencies: { '': 'TWD' },
    });
    const p = transform(b, mapping, 'a'.repeat(64));
    expect(p.report.errors).toEqual([]);
    expect(p.report.skipped).toEqual([]);
    expect(p.report.unknown_currencies).toEqual({});
    expect(p.items.find((i) => i.name === '合成外幣戶')!.currency).toBe('JPY');
    expect(p.transactions).toHaveLength(2);
    for (const t of p.transactions)
      expect(sumMoney(t.entries.map((e) => e.base_amount))).toBe('0.000000');
    expect(p.transactions[1]!.entries[0]).toMatchObject({
      currency: 'JPY',
      amount: '-100.000000',
      base_amount: '-21.00',
    });
    expect(p.mapping_sha256).toBe('a'.repeat(64));
  }
});
it('explicit TWD confirms base and ignores item rate (including invalid), warning counted', async () => {
  for (const rate of ['0.21', 'NaN', '1.0000']) {
    const b = await source();
    b.tables.get('ITEM_DATA')![0]!.EXCHANGE = rate;
    b.tables.get('MYMONEY_DATA')![1]!.IN_MOUNT = '100';
    const p = transform(b, explicit('TWD'), null);
    expect(p.report.errors).toEqual([]);
    expect(p.report.skipped).toEqual([]);
    expect(p.report.warning_counts.item_rate_ignored_base_currency).toBe(1);
    expect(p.report.warning_details).toContainEqual({
      code: 'item_rate_ignored_base_currency',
      table: 'ITEM_DATA',
      row: 1,
      key: JSON.stringify(['資產', '合成外幣戶']),
    });
    for (const t of p.transactions)
      for (const e of t.entries) expect(e.exchange_rate).toBe('1.0000000000');
  }
});
it('mapping references are exact source pairs; absent class/name/case variants fail mapping validation', async () => {
  for (const [item_class, item_note] of [
    ['負債', '合成外幣戶'],
    ['資產', '不存在'],
    [' 資產', '合成外幣戶'],
  ]) {
    const b = await source();
    const m = mappingSchema.parse({
      item_currencies: [{ item_class, item_note, currency: 'JPY' }],
    });
    expect(() => transform(b, m, null)).toThrow('mapping_item_not_found');
  }
  const b = await source();
  b.tables.get('ITEM_DATA')![0]!.ITEM_NOTE = ' 合成外幣戶 ';
  expect(transform(b, explicit('JPY'), null).report.errors).toEqual([]);
});
it('mapping schema defaults legacy inputs; invalid ISO/unknown fields/duplicate overrides rejected', () => {
  expect(mappingSchema.parse({}).item_currencies).toEqual([]);
  for (const entry of [
    { item_class: '資產', item_note: 'x', currency: 'jpy' },
    { item_class: '資產', item_note: 'x', currency: 'JPY', extra: true },
  ])
    expect(mappingSchema.safeParse({ item_currencies: [entry] }).success).toBe(
      false,
    );
  expect(
    mappingSchema.safeParse({
      item_currencies: [
        ...explicit('JPY').item_currencies,
        ...explicit('TWD').item_currencies,
      ],
    }).success,
  ).toBe(false);
});
it('no guessing by rate magnitude; non-balance items and missing/unit rates are not ambiguous; repeated pair counts collected', async () => {
  for (const rate of ['0.0001', '32.5', '-1', 'NaN']) {
    const b = await source();
    b.tables.get('ITEM_DATA')![0]!.EXCHANGE = rate;
    expect(
      transform(b, mappingSchema.parse({}), null).report.errors.some(
        (e) => e.code === 'ambiguous_item_currency',
      ),
    ).toBe(true);
  }
  for (const rate of ['', '1', '1.0000000000']) {
    const b = await source();
    b.tables.get('ITEM_DATA')![0]!.EXCHANGE = rate;
    b.tables.get('ITEM_DATA')![0]!.BEFORE_MOUNT = '0';
    expect(transform(b, mappingSchema.parse({}), null).report.errors).toEqual(
      [],
    );
  }
  const b = await source();
  b.tables.get('ITEM_DATA')!.push({ ...b.tables.get('ITEM_DATA')![0]! });
  const p = transform(b, mappingSchema.parse({}), null);
  expect(p.report.errors).toContainEqual(
    expect.objectContaining({ code: 'ambiguous_item_currency', count: 2 }),
  );
  expect(p.report.errors).toContainEqual(
    expect.objectContaining({ code: 'duplicate_item_identity' }),
  );
  const other = await source();
  other.tables.get('ITEM_DATA')![0]!.ITEM_CLASS = '支出';
  other.tables.get('ITEM_DATA')![0]!.BEFORE_MOUNT = '0';
  expect(transform(other, mappingSchema.parse({}), null).report.errors).toEqual(
    [],
  );
});
