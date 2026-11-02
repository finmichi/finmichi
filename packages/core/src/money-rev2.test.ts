// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import {
  calculateBaseAmounts as calc,
  calculateImportBaseAmounts as imp,
  roundHalfUp,
  MoneyError,
  type MoneyEntry,
} from './money.js';
const fx = (
  amount: string,
  currency = 'USD',
  exchangeRate = '1',
): MoneyEntry => ({ amount, currency, exchangeRate });
const twd = (amount: string) => fx(amount, 'TWD');
const bases = (entries: MoneyEntry[]) =>
  calc(entries).entries.map((e) => e.baseAmount);
const code = (run: () => unknown, expected: string) => {
  try {
    run();
    throw new Error('Expected MoneyError');
  } catch (e) {
    expect(e).toBeInstanceOf(MoneyError);
    expect((e as MoneyError).code).toBe(expected);
  }
};
it.each([
  ['0.005', '0.01'],
  ['-0.005', '-0.01'],
  ['1.005', '1.01'],
  ['-1.005', '-1.01'],
  ['2.675', '2.68'],
  ['-2.675', '-2.68'],
  ['0.0049', '0.00'],
  ['-0.0049', '0.00'],
])('HALF_UP %s -> %s', (a, b) => {
  expect(roundHalfUp(a)).toBe(b);
});
it('A: income, expense and transfer preserve base amounts exactly', () => {
  for (const amount of ['100', '0.01', '99999999999999.99'])
    expect(bases([twd('-' + amount), twd(amount)])).toEqual([
      roundHalfUp('-' + amount),
      roundHalfUp(amount),
    ]);
  code(() => calc([twd('-1'), twd('1.01')]), 'unbalanced');
  code(() => calc([twd('-0.001'), twd('0.001')]), 'invalid_money_entry');
  code(() => calc([twd('-1'), fx('1', 'TWD', '2')]), 'invalid_money_entry');
});
it('B: two USD legs at 32.567 automatically cancel, preserving source precision', () => {
  const r = calc([fx('-33.33', 'USD', '32.567'), fx('33.33', 'USD', '32.567')]);
  expect(r.scenario).toBe('BD');
  expect(r.entries.map((e) => e.baseAmount)).toEqual(['-1085.46', '1085.46']);
  expect(r.entries[0]!.amount).toBe('-33.33');
});
it('B/D: skips zero-producing candidates in the reported three-leg case', () => {
  expect(bases([fx('0.005'), fx('0.005'), fx('-0.010')])).toEqual([
    '0.01',
    '0.01',
    '-0.02',
  ]);
});
it('B/D: distributes six cents over six distinct entries; seven cents is rejected', () => {
  const entries = Array.from({ length: 6 }, () => fx('1.004'));
  expect(bases([...entries, twd('-6.06')])).toEqual([
    '1.01',
    '1.01',
    '1.01',
    '1.01',
    '1.01',
    '1.01',
    '-6.06',
  ]);
  code(() => calc([...entries, twd('-6.07')]), 'fx_residual_exceeds_tolerance');
});
it('B/D: ranks error first, then exact magnitude, then original input order', () => {
  expect(bases([fx('1.001'), fx('2.004'), twd('-3.01')])).toEqual([
    '1.00',
    '2.01',
    '-3.01',
  ]);
  expect(bases([fx('3.004'), fx('2.004'), twd('-5.01')])).toEqual([
    '3.01',
    '2.00',
    '-5.01',
  ]);
  expect(bases([fx('1.004'), fx('1.004'), twd('-2.01')])).toEqual([
    '1.01',
    '1.00',
    '-2.01',
  ]);
  expect(bases([fx('1.009'), fx('2.006'), twd('-3.01')])).toEqual([
    '1.01',
    '2.00',
    '-3.01',
  ]);
});
it('B/D: rejects rounded zero and insufficient nonzero/same-sign candidates', () => {
  code(() => calc([fx('0.004'), fx('-0.004')]), 'base_amount_rounds_to_zero');
  code(
    () => calc([fx('0.005'), fx('0.005'), twd('-0.01')]),
    'fx_residual_exceeds_tolerance',
  );
});
it('C: actual TWD3251 for USD100 persists effective rate32.51 and exposes >5% warning', () => {
  const r = calc([fx('-100', 'USD', '32.5'), twd('3251')]);
  expect(r.scenario).toBe('C');
  expect(r.entries[0]).toMatchObject({
    amount: '-100',
    baseAmount: '-3251.00',
    exchangeRate: '32.5100000000',
  });
  expect(r.warnings).toEqual([]);
  expect(calc([fx('-100', 'USD', '30'), twd('3251')]).warnings).toEqual([
    { code: 'fx_rate_deviation', entryIndex: 0 },
  ]);
  expect(calc([fx('-100', 'USD', '30'), twd('3150')]).warnings).toEqual([]);
});
it('C: large original amount remains exact and effective rate is rounded to 10 decimals', () => {
  const r = calc([fx('-99999999.999999', 'USD', '32.5'), twd('3251000000.01')]);
  expect(r.entries[0]!.amount).toBe('-99999999.999999');
  expect(r.entries[0]!.baseAmount).toBe('-3251000000.01');
  expect(r.entries[0]!.exchangeRate).toBe('32.5100000001');
});
it('B/D: USD to JPY plus TWD fee applies one cent or rejects excess', () => {
  expect(
    bases([fx('-1', 'USD', '32.5'), fx('160', 'JPY', '0.2'), twd('0.51')]),
  ).toEqual(['-32.51', '32.00', '0.51']);
  code(
    () => calc([fx('-1', 'USD', '32.5'), fx('160', 'JPY', '0.2'), twd('0.53')]),
    'fx_residual_exceeds_tolerance',
  );
});
it('import: residual0.37 plans a traced system income entry;1.01 is unbalanced', () => {
  const entries = [fx('1'), fx('-0.63', 'JPY')],
    r = imp(entries);
  expect(r.entries.slice(0, 2).map((e) => e.amount)).toEqual(['1', '-0.63']);
  expect(r.entries[2]).toMatchObject({
    currency: 'TWD',
    amount: '-0.37',
    baseAmount: '-0.37',
    systemItem: {
      name: '匯兌尾差',
      kind: 'income',
      nonOperating: true,
      systemCreated: true,
      sourceReason: 'fx_rounding_residual',
    },
  });
  expect(calc([fx('-100', 'USD', '32.5'), twd('3251')]).entries).toEqual(
    imp([fx('-100', 'USD', '32.5'), twd('3251')]).entries,
  );
  code(() => imp([fx('2.01'), fx('-1', 'JPY')]), 'unbalanced');
  code(() => imp([fx('0.004'), fx('-0.004')]), 'base_amount_rounds_to_zero');
  code(
    () => imp([fx('0.005'), fx('0.005'), twd('-0.01')]),
    'fx_residual_exceeds_tolerance',
  );
});
it.each(['NaN', 'Infinity', '1e3', '1.0000001', '100000000000000'])(
  'rejects invalid source amount %s without rounding it',
  (amount) => {
    code(() => calc([fx(amount), fx('-1')]), 'invalid_money_entry');
  },
);

it('C exposes exact decimal comparison metadata and preserves the exact >5% boundary', () => {
  const result = calc([fx('-100', 'USD', '32.5'), twd('4000')]);
  expect(result.fxComparisons).toEqual([
    {
      entryIndex: 0,
      effectiveRate: '40.0000000000',
      referenceRate: '32.5000000000',
      deviationPercent: '23.0769230769',
    },
  ]);
  expect(calc([fx('-100', 'USD', '32.5'), twd('3412.50')]).warnings).toEqual(
    [],
  );
  expect(calc([fx('-100', 'USD', '32.5'), twd('3412.51')]).warnings).toEqual([
    { code: 'fx_rate_deviation', entryIndex: 0 },
  ]);
  expect(
    calc([{ amount: '-100', currency: 'USD' }, twd('4000')]).fxComparisons[0],
  ).toMatchObject({ referenceRate: null, deviationPercent: null });
});
