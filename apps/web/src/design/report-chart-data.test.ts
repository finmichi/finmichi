// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { incomeCoordinates } from './report-chart-data';
const row = (value: string) => ({
  operating_income: value,
  non_operating_income: '0',
  operating_expense: '0',
  non_operating_expense: '0',
  income_total: value,
  expense_total: '0',
  net_income: value,
});
describe('report chart presentation coordinates', () => {
  it('normalizes huge decimal strings and preserves signed direction without rounding labels', () => {
    const r = incomeCoordinates([
      row('99999999999999.123456'),
      row('-99999999999999.123456'),
    ]);
    expect(r.map((v) => v.operating_income)).toEqual([100, -100]);
  });
  it('handles zero-filled periods without NaN', () => {
    expect(incomeCoordinates([row('0')])[0]!.operating_income).toBe(0);
    expect(incomeCoordinates([])).toEqual([]);
  });
});
