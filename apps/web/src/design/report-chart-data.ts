// SPDX-License-Identifier: AGPL-3.0-only
import type { IncomeValues } from '@finmichi/core/report-schemas';
import { units } from './display-math';
const keys = [
  'operating_income',
  'non_operating_income',
  'operating_expense',
  'non_operating_expense',
] as const;
// Chart coordinates only: normalize with BigInt first to avoid overflow or floating-point monetary calculations.
// Every label and tooltip uses the original SQL decimal string.
export function incomeCoordinates(periods: IncomeValues[]) {
  const max = periods.reduce(
    (m, row) =>
      keys.reduce((n, key) => {
        const v = units(row[key]);
        const abs = v < 0n ? -v : v;
        return abs > n ? abs : n;
      }, m),
    0n,
  );
  return periods.map(
    (row) =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          max === 0n ? 0 : Number((units(row[key]) * 1000000n) / max) / 10000,
        ]),
      ) as Record<(typeof keys)[number], number>,
  );
}
