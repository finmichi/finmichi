// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { assertBalanced, moneyUnits, formatMoney, sumMoney } from './money.js';
it('sums decimal strings exactly, including 0.1 + 0.2 and signed extremes', () => {
  expect(sumMoney(['0.1', '0.2'])).toBe('0.300000');
  expect(sumMoney(['99999999999999.999999', '-99999999999999.999998'])).toBe(
    '0.000001',
  );
  expect(formatMoney(moneyUnits('-0.000001'))).toBe('-0.000001');
  expect(sumMoney(['-0'])).toBe('0.000000');
});
it.each([
  'NaN',
  'Infinity',
  '1e3',
  '1.0000001',
  '100000000000000',
  ' 1',
  '1,000',
  '',
])('rejects invalid or overflowing money %s', (value) => {
  expect(() => moneyUnits(value)).toThrow();
});
it('enforces exact zero and two legs, without rounding a small imbalance away', () => {
  expect(() => assertBalanced(['-3250', '3250.000000'])).not.toThrow();
  expect(() => assertBalanced(['-3250', '3250.000001'])).toThrow();
  expect(() => assertBalanced(['0'])).toThrow();
  expect(() => sumMoney(['99999999999999.999999', '0.000001'])).toThrow();
});
