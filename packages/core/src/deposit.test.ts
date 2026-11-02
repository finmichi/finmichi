// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import fc from 'fast-check';
import { depositSchedule, depositNet, renewedTerm } from './deposit-math.js';
import type { DepositInput } from './deposit-schemas.js';
import { stockFixed } from './securities-math.js';
const base = {
  principal: '1000000',
  annual_rate: '1.7',
  start_on: '2026-01-31',
  maturity_on: '2027-01-31',
  interest_basis: 'monthly',
  payout: 'monthly',
} as DepositInput;
it('independent rational monthly oracle and nonnegative cumulative rounding', () => {
  const s = depositSchedule(base);
  expect(s.total_interest).toBe('17000.00');
  expect(s.periods.map((p) => p.interest)).toEqual(
    Array.from({ length: 4 }, () => ['1416.67', '1416.66', '1416.67']).flat(),
  );
  expect(
    depositSchedule({
      ...base,
      principal: '0.06',
      annual_rate: '100',
    }).periods.map((p) => p.interest),
  ).toEqual(Array.from({ length: 6 }, () => ['0.01', '0.00']).flat());
});
it('daily independent Fraction oracle including leap day and partial final period', () => {
  const s = depositSchedule({
    ...base,
    interest_basis: 'daily',
    maturity_on: '2026-04-15',
  });
  expect(s.days).toBe(74);
  expect(s.total_interest).toBe('3446.58');
  expect(s.periods.map((p) => [p.due_on, p.interest])).toEqual([
    ['2026-02-28', '1304.11'],
    ['2026-03-31', '1443.84'],
    ['2026-04-15', '698.63'],
  ]);
  expect(
    depositSchedule({
      ...base,
      interest_basis: 'daily',
      start_on: '2024-01-31',
      maturity_on: '2024-02-29',
    }).total_interest,
  ).toBe('1350.68');
});
it('month anchor clamps and invalid terms rejected; renewal preserves basis duration', () => {
  expect(
    depositSchedule({ ...base, maturity_on: '2026-02-28' }).periods[0]!.due_on,
  ).toBe('2026-02-28');
  expect(() => depositSchedule({ ...base, maturity_on: '2026-02-27' })).toThrow(
    'deposit_term_invalid',
  );
  expect(() =>
    depositSchedule({ ...base, maturity_on: base.start_on }),
  ).toThrow('deposit_term_invalid');
  expect(renewedTerm({ ...base, maturity_on: '2026-02-28' })).toEqual({
    start_on: '2026-02-28',
    maturity_on: '2026-03-28',
  });
  expect(
    renewedTerm({
      ...base,
      interest_basis: 'daily',
      maturity_on: '2026-02-28',
    }),
  ).toEqual({ start_on: '2026-02-28', maturity_on: '2026-03-28' });
});
it('negative amounts and deductions exceeding gross have ADR code', () => {
  for (const d of [
    { gross_interest: '-1', withholding_tax: '0', nhi_premium: '0' },
    { gross_interest: '1', withholding_tax: '-1', nhi_premium: '0' },
    { gross_interest: '1', withholding_tax: '0', nhi_premium: '-1' },
    { gross_interest: '1', withholding_tax: '1', nhi_premium: '0.01' },
  ])
    expect(() => depositNet(d)).toThrow('deposit_amount_invalid');
  expect(
    depositNet({
      gross_interest: '10',
      withholding_tax: '10',
      nhi_premium: '0',
    }),
  ).toBe('0.00');
});
it('property: period interest nonnegative, exact total and independently rounded cumulative cents', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 999999999999n }),
      fc.bigInt({ min: 0n, max: 100000000n }),
      (principal, rate) => {
        const s = depositSchedule({
          ...base,
          principal: stockFixed(principal),
          annual_rate: stockFixed(rate, 6),
        });
        let total = 0n;
        for (let k = 0; k < 12; k++) {
          const [a, b] = s.periods[k]!.interest.split('.');
          const value = BigInt(a!) * 100n + BigInt(b!);
          expect(value >= 0n).toBe(true);
          total += value;
          const numerator = principal * rate * BigInt(k + 1),
            denom = 1200000000n;
          const expected =
            numerator / denom + ((numerator % denom) * 2n >= denom ? 1n : 0n);
          expect(total).toBe(expected);
        }
        expect(stockFixed(total)).toBe(s.total_interest);
      },
    ),
    { numRuns: 500 },
  );
});
