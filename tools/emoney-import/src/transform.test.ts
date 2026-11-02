// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle, readMapping, sha256, type Bundle } from './bundle.js';
import { mappingSchema, planSchema } from './schema.js';
import { transform } from './transform.js';
import { sumMoney } from '@finmichi/core';
export const fixture = fileURLToPath(new URL('../fixtures/', import.meta.url));
const make = async () => readBundle(fixture);
const convert = (b: Bundle, m: unknown = {}) =>
  transform(b, mappingSchema.parse(m), null);
describe('E-Money CSV transform (generated fixtures only)', () => {
  it('preserves all five sign pairings, C/BD zero-sum and 0.37 residual, rejects 1.01', async () => {
    const plan = convert(await make());
    expect(plan.report.errors).toEqual([]);
    expect(planSchema.safeParse(plan).success).toBe(true);
    for (const t of plan.transactions)
      expect(sumMoney(t.entries.map((e) => e.base_amount))).toBe('0.000000');
    for (const [key, amounts] of [
      ['expense', ['-120.000000', '120.000000']],
      ['income', ['-35000.000000', '35000.000000']],
      ['card', ['-500.000000', '500.000000']],
      ['repay', ['-500.000000', '500.000000']],
      ['transfer', ['-1000.000000', '1000.000000']],
    ] as const)
      expect(
        plan.transactions
          .find((t) => t.source_key === key)!
          .entries.map((e) => e.amount),
      ).toEqual(amounts);
    expect(
      plan.transactions.find((t) => t.source_key === 'foreign')!.entries[0],
    ).toMatchObject({
      amount: '-100.000000',
      exchange_rate: '32.0000000000',
      base_amount: '-3200.00',
    });
    expect(
      plan.transactions.find((t) => t.source_key === 'residual')!.entries[2]!
        .amount,
    ).toBe('-0.37');
    expect(plan.report).toMatchObject({
      fx_rounding_count: 1,
      fx_rounding_total: '-0.370000',
      unbalanced_total: '1.010000',
      single_leg_adjustment_count: 1,
    });
    expect(plan.report.skipped).toContainEqual(
      expect.objectContaining({
        code: 'unbalanced',
        key: 'unbalanced',
        difference: '1.010000',
      }),
    );
    expect(
      plan.items
        .filter((i) => i.name === '銀行')
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['asset', 'liability']);
    expect(plan.items.find((i) => i.name === '活存')!.parent_key).toBe(
      plan.items.find((i) => i.name === '銀行' && i.kind === 'asset')!.key,
    );
  });
  it('keeps exact RFC quoted/newline memo, P3 staging and source price/rate dates', async () => {
    const p = convert(await make());
    expect(p.transactions.find((t) => t.source_key === 'expense')!.memo).toBe(
      '合成, "摘要"\n第二行\n附註',
    );
    expect(p.staging.STOCK_DATA![0]!.INOUT_DATE).toBe('2025/01/01');
    expect(p.staging.STOCK_DATA![0]!.parsed_inout_date).toBe('2025-01-01');
    expect(p.staging.STOCK_ID_DATA![0]).toMatchObject({
      as_of_date: '2025-12-31',
      as_of_source: 'false',
    });
    expect(p.report.parsed_only_counts).toMatchObject({
      REGULAR_DATA: 1,
      STOCK_DATA: 1,
      STOCK_ID_DATA: 1,
    });
    expect(p.rates[0]).toMatchObject({
      rate_date: '2026-01-02',
      as_of_source: false,
    });
  });
  it('uses source file date only for absent price/rate date, never now', async () => {
    const b = await make();
    delete b.tables.get('CURRENCY_SET')![0]!.RATE_DATE;
    delete b.tables.get('STOCK_ID_DATA')![0]!.PRICE_DATE;
    const p = convert(b);
    expect(p.rates[0]).toMatchObject({
      rate_date: '2026-01-10',
      as_of_source: true,
    });
    expect(p.staging.STOCK_ID_DATA![0]).toMatchObject({
      as_of_date: '2026-01-10',
      as_of_source: 'true',
    });
  });
  it('reports negative natural income despite zero-sum pair', async () => {
    const b = await make();
    for (const row of b.tables
      .get('MYMONEY_DATA')!
      .filter((r) => r.DATA_KEY === 'income'))
      [row.IN_MOUNT, row.OUT_MOUNT] = [row.OUT_MOUNT!, row.IN_MOUNT!];
    const p = convert(b);
    expect(p.report.warnings[0]).toBe('sign_convention_suspect');
    expect(p.report.kind_natural_totals.income!.startsWith('-')).toBe(true);
  });
  it('counts every unknown class/currency; explicit per-item mapping wins', async () => {
    const b = await make();
    b.tables.get('ITEM_DATA')![0]!.ITEM_CLASS = '其它';
    b.tables.get('ITEM_DATA')![0]!.EXCHANGE_NOTE = '某幣';
    for (const row of b.tables
      .get('MYMONEY_DATA')!
      .filter((r) => r.ITEM_NOTE === '現金')) {
      row.ITEM_CLASS = '其它';
      row.EXCHANGE = '32';
    }
    const bad = convert(b);
    expect(bad.report.unknown_item_classes['其它']).toBeGreaterThan(1);
    expect(bad.report.unknown_currencies['某幣']).toBe(1);
    const p = convert(b, {
      item_classes: { 其它: { kind: 'equity' } },
      items: [{ item_class: '其它', item_note: '現金', kind: 'asset' }],
      currencies: { 某幣: 'USD' },
      opening_rates: { 現金: '32' },
    });
    expect(p.report.unknown_currencies).toEqual({});
    expect(p.report.unknown_item_classes).toEqual({});
    expect(p.items.find((i) => i.name === '現金')!.kind).toBe('asset');
  });
  it('invalid dates/no mapped leg/missing project are explicit skipped groups; NaN is fatal', async () => {
    const b = await make(),
      r = b.tables.get('MYMONEY_DATA')![0]!;
    r.DATA_DATE = '2026/02/30';
    r.PROJECT_ID = 'missing';
    r.ITEM_NOTE = 'unknown';
    r.IN_MOUNT = 'NaN';
    const p = convert(b);
    expect(p.report.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid_amount' }),
    );
    expect(p.report.skipped).toContainEqual(
      expect.objectContaining({ code: 'invalid_date' }),
    );
    expect(p.report.missing_projects).toEqual({ missing: 1 });
    expect(p.transactions.some((t) => t.source_key === 'expense')).toBe(false);
    const b2 = await make();
    b2.tables.get('MYMONEY_DATA')![0]!.ITEM_NOTE = 'unknown';
    expect(convert(b2).report.skipped).toContainEqual(
      expect.objectContaining({ code: 'no_item_leg' }),
    );
  });
  it('missing DATA_KEY gets explicit fallback and single-leg adjustment', async () => {
    const b = await make();
    b.tables.set('MYMONEY_DATA', [
      {
        DATA_DATE: '2026/01/02',
        ITEM_CLASS: '資產',
        ITEM_NOTE: '銀行',
        IN_MOUNT: '5',
        OUT_MOUNT: '0',
        EXCHANGE: '1',
        MAKE_NO2: 'abc',
      },
    ]);
    const t = convert(b).transactions.find((t) =>
      t.source_key.startsWith('fallback:'),
    )!;
    expect(t).toMatchObject({
      source_key: 'fallback:abc:1',
      kind: 'adjustment',
    });
  });
  it('opening uses signed source amounts, earliest-1 date, independent of adjustments', async () => {
    const p = convert(await make());
    const a = p.transactions.find(
        (t) => t.source_key === 'ITEM_DATA:資產|現金:opening',
      )!,
      b = p.transactions.find(
        (t) => t.source_key === 'ITEM_DATA:負債|信用卡:opening',
      )!,
      usd = p.transactions.find(
        (t) => t.source_key === 'ITEM_DATA:資產|美元帳戶:opening',
      )!;
    expect(a).toMatchObject({ occurred_on: '2026-01-01', kind: 'adjustment' });
    expect(a.entries[0]!.amount).toBe('10000.000000');
    expect(b.entries[0]!.amount).toBe('-3000.000000');
    expect(usd.entries.map((e) => e.base_amount)).toEqual([
      '3200.00',
      '-3200.00',
    ]);
    expect(p.report.opening_balances).toHaveLength(3);
  });
  it('opening missing/override rate, ignored non-balance, explicit date checks', async () => {
    const b = await make();
    b.tables.get('ITEM_DATA')![5]!.EXCHANGE = '';
    b.tables.get('ITEM_DATA')![4]!.BEFORE_MOUNT = '50';
    expect(convert(b).report.errors).toContainEqual(
      expect.objectContaining({ code: 'opening_rate_missing' }),
    );
    const p = convert(b, { opening_rates: { 美元帳戶: '32' } });
    expect(p.report.errors).toEqual([]);
    expect(p.report.warnings).toContain('opening_ignored_non_balance_item');
    expect(
      p.transactions.some(
        (t) => t.source_key === 'ITEM_DATA:支出|餐費:opening',
      ),
    ).toBe(false);
    expect(() =>
      transform(b, mappingSchema.parse({}), null, '2026-01-02'),
    ).toThrow('opening_date_after_first_transaction');
    b.tables.set('MYMONEY_DATA', []);
    expect(
      convert(b, { opening_rates: { 美元帳戶: '32' } }).report
        .opening_balances[0]!.occurred_on,
    ).toBe('2026-01-10');
  });
  it('duplicate opening warning preserves both unless explicitly excluded', async () => {
    const b = await make();
    b.tables.set('MYMONEY_DATA', [
      {
        DATA_KEY: 'dup',
        DATA_DATE: '2026/01/02',
        ITEM_CLASS: '資產',
        ITEM_NOTE: '現金',
        IN_MOUNT: '10000',
        OUT_MOUNT: '0',
        EXCHANGE: '1',
      },
    ]);
    const p = convert(b);
    expect(p.report.warnings).toContain('possible_duplicate_opening');
    expect(p.transactions.some((t) => t.source_key === 'dup')).toBe(true);
    expect(
      p.transactions.some(
        (t) => t.source_key === 'ITEM_DATA:資產|現金:opening',
      ),
    ).toBe(true);
    const q = convert(b, { exclude_opening: ['現金'] });
    expect(
      q.transactions.some(
        (t) => t.source_key === 'ITEM_DATA:資產|現金:opening',
      ),
    ).toBe(false);
    expect(q.transactions.some((t) => t.source_key === 'dup')).toBe(true);
  });
  it('strict private mapping SHA and unsupported fields rejected', async () => {
    const file = fileURLToPath(
        new URL('../mapping.example.json', import.meta.url),
      ),
      r = await readMapping(file);
    expect(r.mappingSha256).toBe(sha256(await readFile(file)));
    expect(() => mappingSchema.parse({ guess_currency: true })).toThrow();
  });
  it('verifies manifest hashes/counts and refuses path traversal/symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emoney-fixture-'));
    try {
      await cp(fixture, dir, { recursive: true });
      const text = await readFile(join(dir, 'manifest.txt'), 'utf8');
      await writeFile(join(dir, 'item_data.csv'), 'tampered');
      await expect(readBundle(dir)).rejects.toThrow('csv_checksum_mismatch');
      await writeFile(
        join(dir, 'manifest.txt'),
        text.replace('ITEM_DATA|', '../secret|'),
      );
      await expect(readBundle(dir)).rejects.toThrow('invalid_manifest');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('CSV BOM/lowercase headers, row count and symlink boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'emoney-boundary-'));
  try {
    await cp(fixture, dir, { recursive: true });
    const file = join(dir, 'item_data.csv'),
      original = await readFile(file),
      manifest = await readFile(join(dir, 'manifest.txt'), 'utf8'),
      changed = Buffer.from(
        '\uFEFF' +
          original.toString('utf8').replace('ITEM_CLASS', 'item_class'),
      );
    await writeFile(file, changed);
    const updated = manifest.replace(sha256(original), sha256(changed));
    await writeFile(join(dir, 'manifest.txt'), updated);
    expect(
      (await readBundle(dir)).tables.get('ITEM_DATA')![0]!.ITEM_CLASS,
    ).toBe('資產');
    await writeFile(
      join(dir, 'manifest.txt'),
      updated.replace('ITEM_DATA|9|', 'ITEM_DATA|10|'),
    );
    await expect(readBundle(dir)).rejects.toThrow('row_count_mismatch');
    await writeFile(join(dir, 'manifest.txt'), updated);
    await rm(file);
    const { symlink } = await import('node:fs/promises');
    await symlink(join(fixture, 'item_data.csv'), file);
    await expect(readBundle(dir)).rejects.toThrow('file_invalid_or_too_large');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('opening fallback converts manifest timestamp to Asia/Taipei calendar date', async () => {
  const b = await make();
  b.tables.set('MYMONEY_DATA', []);
  b.exportedAt = '2026-01-10T20:00:00Z';
  expect(convert(b).report.opening_balances[0]!.occurred_on).toBe('2026-01-10');
});
