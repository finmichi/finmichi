// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import {
  add,
  negate,
  percent,
  todayTaipei,
  monthStart,
  units,
} from './display-math';
import { filtersFromLocation, filtersUrl, cleanFilters } from './query-state';
it('aggregates huge, signed and six-decimal display values without float precision loss', () => {
  expect(add(['999999999999999999.990000', '0.010000'])).toBe(
    '1000000000000000000.000000',
  );
  expect(add(['0.000001', '-0.000002'])).toBe('-0.000001');
  expect(negate('-120.37')).toBe('120.370000');
  expect(units('0')).toBe(0n);
});
it('savings percentage is decimal HALF_UP and undefined only for zero denominator', () => {
  expect(percent('1', '3')).toBe('33.3333333333');
  expect(percent('-1', '3')).toBe('-33.3333333333');
  expect(percent('2', '-3')).toBe('-66.6666666667');
  expect(percent('0', '0')).toBeNull();
});
it('uses Taipei dates at UTC day boundaries and handles year/month transitions', () => {
  expect(todayTaipei(new Date('2026-12-31T16:30:00Z'))).toBe('2027-01-01');
  expect(monthStart('2027-01-31', -2)).toBe('2026-11-01');
  expect(monthStart('2024-03-31', -1)).toBe('2024-02-01');
});
it('shareable AND filters round-trip unicode and punctuation; unknown keys never reach API', () => {
  const input = {
    keyword: ' =合成 & 茶 ',
    kind: 'expense',
    amount_min: '0.00',
    owner_id: 'untrusted',
    cursor: 'old',
  };
  const url = filtersUrl(input);
  expect(url).not.toContain('owner_id');
  expect(url).not.toContain('cursor');
  expect(cleanFilters(filtersFromLocation(url))).toEqual({
    keyword: '=合成 & 茶',
    kind: 'expense',
    amount_min: '0.00',
  });
  expect(filtersFromLocation('/transactions').keyword).toBe('');
});

import { queryProfit } from './query-profit';
it('mixed entries use P&L own amounts: day -420 and month expense 3420', () => {
  const mixed = [
    { kind: 'asset' as const, natural_amount: '-300' },
    { kind: 'expense' as const, natural_amount: '200' },
    { kind: 'asset' as const, natural_amount: '100' },
    { kind: 'expense' as const, natural_amount: '220' },
  ];
  expect(queryProfit(mixed).net).toBe('-420.000000');
  expect(
    queryProfit([...mixed, { kind: 'expense', natural_amount: '3000' }])
      .expense,
  ).toBe('3420.000000');
});
it('income, refunds and liability entries retain their P&L signs without counting transfers', () => {
  expect(
    queryProfit([
      { kind: 'income', natural_amount: '500' },
      { kind: 'expense', natural_amount: '-20' },
      { kind: 'liability', natural_amount: '999' },
    ]),
  ).toEqual({ income: '500.000000', expense: '-20.000000', net: '520.000000' });
});
