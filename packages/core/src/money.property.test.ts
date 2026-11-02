// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import fc from 'fast-check';
import { calculateBaseAmounts, MoneyError, type MoneyEntry } from './money.js';

// Independent rational oracle: BigInt numerator at 10^-16, never JS monetary floats.
const abs = (n: bigint) => (n < 0n ? -n : n);
const unit = 100_000_000_000_000n; // one cent at product precision
function decimal(n: bigint, places: number): string {
  const s = abs(n)
    .toString()
    .padStart(places + 1, '0');
  return `${n < 0n ? '-' : ''}${s.slice(0, -places)}.${s.slice(-places)}`;
}
function parse(s: string, places: number): bigint {
  const [whole, fraction = ''] = s.replace('-', '').split('.');
  return (
    (s.startsWith('-') ? -1n : 1n) *
    BigInt(whole! + fraction.padEnd(places, '0'))
  );
}
function halfUp(n: bigint, d: bigint): bigint {
  const q = abs(n) / d;
  return (n < 0n ? -1n : 1n) * (q + (2n * (abs(n) % d) >= d ? 1n : 0n));
}
const nonzero = (max: bigint) => fc.bigInt({ min: 1n, max });
const sign = fc.constantFrom(1n, -1n);
const amount = fc
  .tuple(nonzero(1_000_000_000_000n), sign)
  .map(([n, s]) => n * s);
const options = { numRuns: 2000, seed: 510051 };
const codes = [
  'invalid_money_entry',
  'unbalanced',
  'base_amount_rounds_to_zero',
  'fx_residual_exceeds_tolerance',
];

function verify(entries: MoneyEntry[]) {
  let result;
  try {
    result = calculateBaseAmounts(entries);
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyError);
    expect(codes).toContain((error as MoneyError).code);
    return false;
  }
  expect(
    result.entries.reduce((sum, e) => sum + parse(e.baseAmount, 2), 0n),
  ).toBe(0n);
  let roundedForeign = 0n,
    target = 0n,
    changed = 0n,
    foreignCount = 0n;
  for (const [index, e] of result.entries.entries()) {
    const a = parse(e.amount, 6),
      rate = parse(e.exchangeRate, 10),
      b = parse(e.baseAmount, 2);
    expect(e.baseAmount).toMatch(/^-?\d+\.\d{2}$/);
    expect(b).not.toBe(0n);
    expect(b > 0n).toBe(a > 0n);
    const exact = a * rate,
      rounded = halfUp(exact, unit);
    // §6: |base - HALF_UP(amount*storedRate,2)| <= .02 + |amount|*1e-10.
    expect(abs(b - rounded) * unit <= 2n * unit + abs(a)).toBe(true);
    if (e.currency === 'TWD') {
      expect(rate).toBe(10_000_000_000n);
      expect(b * 10_000n).toBe(a);
      target -= b;
    } else if (result.scenario === 'BD') {
      const original = a * parse(entries[index]!.exchangeRate!, 10);
      const originalRounded = halfUp(original, unit);
      expect(abs(b * unit - original) * 2n <= 3n * unit).toBe(true); // <= .015
      expect(abs(b - originalRounded) <= 1n).toBe(true);
      if (b !== originalRounded) changed++;
      roundedForeign += originalRounded;
      foreignCount++;
    } else if (result.scenario === 'C') {
      expect(rate).toBe(halfUp(abs(b) * unit, abs(a)));
      expect(2n * abs(b * unit - exact) <= unit + abs(a)).toBe(true);
      const baseSum = result.entries
        .filter((r) => r.currency === 'TWD')
        .reduce((s, r) => s + parse(r.baseAmount, 2), 0n);
      expect(b).toBe(-baseSum);
    }
  }
  if (result.scenario === 'BD') {
    expect(changed).toBe(abs(target - roundedForeign));
    expect(changed <= foreignCount).toBe(true);
  }
  return true;
}

it('A: exact zero, nonzero signs, cents, base rate and §6 over generated balanced ledgers', () => {
  fc.assert(
    fc.property(
      fc.array(nonzero(1_000_000_000_000n), { minLength: 1, maxLength: 12 }),
      sign,
      (cents, direction) => {
        const rows = [...cents, -cents.reduce((s, n) => s + n, 0n)];
        expect(
          verify(
            rows.map((n) => ({
              amount: decimal(n * direction, 2),
              currency: 'TWD',
            })),
          ),
        ).toBe(true);
      },
    ),
    options,
  );
});
it('C: anchor-derived base, rounded effective rate and magnitude-dependent deviation', () => {
  fc.assert(
    fc.property(
      nonzero(99_999_999_999_999_999_999n),
      nonzero(1_000_000_000_000n),
      sign,
      (a, base, direction) => {
        // Very large amounts / tiny bases can validly reject a rate rounded to zero.
        verify([
          { amount: decimal(-a * direction, 6), currency: 'USD' },
          { amount: decimal(base * direction, 2), currency: 'TWD' },
        ]);
      },
    ),
    options,
  );
  expect(
    verify([
      {
        amount: '-99999999999999.123456',
        currency: 'USD',
        exchangeRate: '0.00003251',
      },
      { amount: '3251000000.99', currency: 'TWD' },
    ]),
  ).toBe(true);
});
it('B/D: bounded exact error, one-cent distinct-entry allocation and exact residual count', () => {
  const row = fc.record({
    amount,
    rate: nonzero(1_000_000_000_000n),
    currency: fc.constantFrom('USD', 'JPY', 'EUR'),
  });
  let successes = 0,
    rejections = 0;
  fc.assert(
    fc.property(
      fc.array(row, { minLength: 2, maxLength: 12 }),
      fc.integer({ min: -14, max: 14 }),
      (rows, jitter) => {
        const target =
          rows.reduce((s, r) => s + halfUp(r.amount * r.rate, unit), 0n) +
          BigInt(jitter);
        const entries: MoneyEntry[] = rows.map((r) => ({
          amount: decimal(r.amount, 6),
          currency: r.currency,
          exchangeRate: decimal(r.rate, 10),
        }));
        if (target !== 0n)
          entries.push({ amount: decimal(-target, 2), currency: 'TWD' });
        if (verify(entries)) successes++;
        else rejections++;
      },
    ),
    options,
  );
  expect(successes).toBeGreaterThan(100);
  expect(rejections).toBeGreaterThan(100);
  // Balanced same-currency pairs exercise no-base B as well as mixed currencies D.
  fc.assert(
    fc.property(amount, nonzero(1_000_000_000_000n), (a, rate) => {
      verify(
        [a, -a].map((n) => ({
          amount: decimal(n, 6),
          currency: 'USD',
          exchangeRate: decimal(rate, 10),
        })),
      );
    }),
    options,
  );
});
it('all rejected generated inputs use only the four ADR error codes', () => {
  const row = fc.record({
    amount: fc.oneof(
      fc.string(),
      amount.map((n) => decimal(n, 6)),
    ),
    currency: fc.oneof(fc.string(), fc.constantFrom('TWD', 'USD')),
    exchangeRate: fc.oneof(
      fc.string(),
      nonzero(1_000_000_000_000n).map((n) => decimal(n, 10)),
    ),
  });
  fc.assert(
    fc.property(fc.array(row, { maxLength: 15 }), (rows) => {
      verify(rows);
    }),
    options,
  );
});
