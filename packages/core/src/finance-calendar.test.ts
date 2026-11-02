// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { amortize, cardPeriod } from './finance-calendar.js';
import {
  centsText,
  scaled,
  validCardSchedule,
  type LoanSettings,
} from './finance-schemas.js';
const uuid = '00000000-0000-4000-8000-000000000001';
const input: LoanSettings = {
  item_id: uuid,
  principal: '1200000.00',
  annual_rate: '2.1',
  term_months: 240,
  first_payment_on: '2027-01-31',
  method: 'annuity',
  payment_account_id: uuid,
  interest_item_id: uuid,
};
describe('ADR0011 rev1.1 exact amortization', () => {
  const reference = JSON.parse(
    readFileSync(
      new URL('./fixtures/loan-decimal-reference.json', import.meta.url),
      'utf8',
    ),
  );
  for (const method of ['annuity', 'equal_principal'] as const) {
    it(
      method +
        ' matches every independent Decimal interest/payment/principal/closing',
      () => {
        expect(
          amortize({ ...input, method }).map(
            ({ principal, interest, payment, closing }) => ({
              principal,
              interest,
              payment,
              closing,
            }),
          ),
        ).toEqual(reference.methods[method]);
      },
    );
    it(
      method +
        ' small zero-rate principal remains nonnegative with final remainder',
      () => {
        const a = amortize({
          ...input,
          method,
          principal: '0.06',
          annual_rate: '0',
          term_months: 12,
        });
        expect(a.map((r) => r.principal)).toEqual([
          ...Array<string>(11).fill('0.00'),
          '0.06',
        ]);
        expect(a.every((r) => r.interest === '0.00')).toBe(true);
        expect(
          amortize({
            ...input,
            method,
            principal: '1000',
            annual_rate: '0',
            term_months: 3,
          }).map((r) => r.principal),
        ).toEqual(['333.33', '333.33', '333.34']);
      },
    );
    it(
      method + ' exact principal conservation for arbitrary legal inputs',
      () => {
        fc.assert(
          fc.property(
            fc.bigInt({ min: 1n, max: 9999999999n }),
            fc.integer({ min: 0, max: 20000000 }),
            fc.integer({ min: 1, max: 600 }),
            (p, r, n) => {
              const rate =
                String(Math.floor(r / 1000000)) +
                '.' +
                String(r % 1000000).padStart(6, '0');
              const rows = amortize({
                ...input,
                method,
                principal: centsText(p),
                annual_rate: rate,
                term_months: n,
              });
              expect(rows.reduce((a, x) => a + scaled(x.principal), 0n)).toBe(
                p,
              );
              for (const row of rows) {
                expect(scaled(row.principal) >= 0n).toBe(true);
                expect(scaled(row.closing) >= 0n).toBe(true);
                expect(scaled(row.payment)).toBe(
                  scaled(row.principal) + scaled(row.interest),
                );
              }
              expect(rows.at(-1)!.closing).toBe('0.00');
            },
          ),
          { numRuns: 150, seed: 20261019 },
        );
      },
    );
  }
  it('anchors month-end dates without drift', () =>
    expect(amortize({ ...input, term_months: 4 }).map((r) => r.due_on)).toEqual(
      ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'],
    ));
});
describe('card schedule', () => {
  const s = {
    item_id: uuid,
    statement_day: 31,
    due_day: 1,
    due_month_offset: 1 as const,
    payment_account_id: null,
    credit_limit: null,
  };
  it('clamps February and applies offset1', () =>
    expect(cardPeriod(s, '2027-02-01')).toEqual({
      from: '2027-02-01',
      to: '2027-02-28',
      due_on: '2027-03-01',
    }));
  it('same-month invalid combinations are rejected', () => {
    for (const [a, b] of [
      [28, 31],
      [31, 1],
      [15, 15],
    ])
      expect(
        validCardSchedule({
          ...s,
          statement_day: a!,
          due_day: b!,
          due_month_offset: 0,
        }),
      ).toBe(false);
  });
  it('27/28 is valid in common and leap February', () => {
    for (const y of ['2027', '2028']) {
      const settings = {
        ...s,
        statement_day: 27,
        due_day: 28,
        due_month_offset: 0 as const,
      };
      expect(validCardSchedule(settings)).toBe(true);
      expect(cardPeriod(settings, y + '-02-01').due_on).toBe(y + '-02-28');
    }
  });
});
