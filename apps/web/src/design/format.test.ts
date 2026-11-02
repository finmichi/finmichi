// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import {
  formatMoney,
  formatRate,
  formatFullRate,
  formatPercent,
  formatDate,
  formatBudgetInput,
} from './format';
it('formats huge decimal strings, half-up ties, grouping, currencies and signs without floating point', () => {
  expect(formatMoney('99999999999999.995')).toBe('NT$ 100,000,000,000,000.00');
  expect(formatMoney('-120')).toBe('−NT$ 120.00');
  expect(formatMoney('43930', 'TWD', { compact: true })).toBe('NT$ 43,930');
  expect(formatMoney('450.37', 'TWD', { compact: true })).toBe('NT$ 450.37');
  expect(formatMoney('1000', 'USD', { compact: true })).toBe('USD 1,000.00');
  expect(formatMoney('52000', 'TWD', { compact: true, sign: 'always' })).toBe(
    '+NT$ 52,000',
  );
  for (const [input, expected] of [
    ['0.005', '0.01'],
    ['1.005', '1.01'],
    ['2.675', '2.68'],
  ]) {
    expect(formatMoney(input, 'USD')).toBe('USD ' + expected);
    expect(formatMoney('-' + input, 'USD')).toBe('−USD ' + expected);
  }
  expect(formatMoney('-0.004')).toBe('NT$ 0.00');
  expect(formatMoney('0.000001', 'USD')).toBe('USD 0.00');
  expect(formatMoney('abc')).toBe('—');
  expect(formatMoney(null)).toBe('—');
});
it('formats rates to four/full ten places and percentages to two places', () => {
  expect(formatRate('32.5100499999')).toBe('32.5100');
  expect(formatRate('32.5100500000')).toBe('32.5101');
  expect(formatFullRate('32.51')).toBe('32.5100000000');
  expect(formatPercent('64.285')).toBe('64.29%');
  expect(formatPercent('-0.005')).toBe('−0.01%');
  expect(formatPercent(null)).toBe('—');
});
it('formats ISO date strings without local timezone shifts and rejects invalid dates', () => {
  expect(formatDate('2026-10-16')).toBe('2026-10-16');
  expect(formatDate('2026-10-16', 'short')).toBe('10-16');
  expect(formatDate('2026-10-16', 'group')).toBe('10/16　週五');
  expect(formatDate('2026-02-30')).toBe('—');
  expect(formatDate('2024-02-29')).toBe('2024-02-29');
  expect(formatDate(undefined)).toBe('—');
});

it('budget inactive fields group strings without changing invalid precision or magnitude', () => {
  expect(formatBudgetInput('999999999999999999.99')).toBe(
    '999,999,999,999,999,999.99',
  );
  expect(formatBudgetInput('1200')).toBe('1,200.00');
  expect(formatBudgetInput('0.6')).toBe('0.60');
  for (const invalid of ['1.001', '-1', '1e3', '', '01'])
    expect(formatBudgetInput(invalid)).toBe(invalid);
});
