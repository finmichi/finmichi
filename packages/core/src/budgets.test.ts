// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import fc from 'fast-check';
import { distributeAnnualBudget } from './budget-schemas.js';
const cents = (s: string) => {
  const [a, b] = s.split('.');
  return BigInt(a!) * 100n + BigInt(b!);
};
it('ADR0010 rev1.1 exact examples keep residual in December', () => {
  for (const [total, base, last] of [
    ['1000', '83.33', '83.37'],
    ['0.06', '0.00', '0.06'],
    ['0.11', '0.00', '0.11'],
    ['0.12', '0.01', '0.01'],
    ['1200.06', '100.00', '100.06'],
    ['0', '0.00', '0.00'],
  ])
    expect(distributeAnnualBudget(total)).toEqual([
      ...Array(11).fill(base),
      last,
    ]);
});
it('arbitrary 0–999999999.99 integer cents preserve sum, precision and nonnegative months without float', () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 99999999999n }), (n) => {
      const input = `${n / 100n}.${String(n % 100n).padStart(2, '0')}`,
        a = distributeAnnualBudget(input);
      expect(a).toHaveLength(12);
      expect(a.every((v) => /^\d+\.\d{2}$/.test(v) && cents(v) >= 0n)).toBe(
        true,
      );
      expect(a.reduce((s, v) => s + cents(v), 0n)).toBe(n);
      expect(new Set(a.slice(0, 11)).size).toBe(1);
      expect(cents(a[11]!) - cents(a[0]!)).toBe(n % 12n);
    }),
    { numRuns: 1000 },
  );
});
it('rejects negative, numeric, excess fractional precision or numeric(20,2) overflow instead of rounding', () => {
  for (const v of [
    '-0.01',
    '1.001',
    '1e3',
    1,
    '1000000000000000000',
    'NaN',
    '',
  ])
    expect(() => distributeAnnualBudget(v)).toThrow();
});
