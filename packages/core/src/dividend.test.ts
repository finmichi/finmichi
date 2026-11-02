// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import fc from 'fast-check';
import { validateDividend } from './dividend-math.js';
import { stockFixed } from './securities-math.js';
const id = '00000000-0000-4000-8000-000000000001';
const base = {
  security_id: id,
  ex_date: '2026-10-01',
  pay_date: '2026-10-15',
  per_share: '1.00500000',
  shares: '100',
  gross_amount: '100.50',
  withholding_tax: '10',
  nhi_premium: '2',
  fee: '1',
  net_amount: '87.50',
  stock_shares: '0',
  components: [
    { code: 'custom', label: '合成', amount: '100.50', taxable: false },
  ],
};
it('validates exact component and deduction cents, without assigning tax meaning', () => {
  expect(validateDividend(base).components[0]!.code).toBe('custom');
});
it.each([
  { gross_amount: '100.51' },
  { net_amount: '87.51' },
  { components: [] },
  { components: [{ code: 'x', label: 'x', amount: '100.49', taxable: true }] },
])('rejects inconsistent dividend %j', (patch) => {
  expect(() => validateDividend({ ...base, ...patch })).toThrow(
    'dividend_amount_mismatch',
  );
});
it('requires pay date and ordered dates', () => {
  expect(() => validateDividend({ ...base, pay_date: undefined })).toThrow(
    'pay_date_required',
  );
  expect(() => validateDividend({ ...base, pay_date: '2026-09-30' })).toThrow(
    'invalid_input',
  );
});
it('allows stock-only, rejects empty or components with zero gross', () => {
  const zero = {
    ...base,
    gross_amount: '0',
    net_amount: '0',
    withholding_tax: '0',
    nhi_premium: '0',
    fee: '0',
    components: [],
    stock_shares: '10',
  };
  expect(validateDividend(zero).stock_shares).toBe('10');
  expect(() => validateDividend({ ...zero, stock_shares: '0' })).toThrow(
    'dividend_empty',
  );
  expect(() =>
    validateDividend({
      ...zero,
      components: [{ code: 'x', label: 'x', amount: '0', taxable: false }],
    }),
  ).toThrow('dividend_amount_mismatch');
});
it('allows full withholding, enforces precision and metadata allowlist', () => {
  expect(
    validateDividend({ ...base, withholding_tax: '97.50', net_amount: '0' })
      .net_amount,
  ).toBe('0');
  expect(() => validateDividend({ ...base, fee: '1.001' })).toThrow(
    'invalid_input',
  );
  expect(() =>
    validateDividend({
      ...base,
      source_document: {
        filename: 'x.pdf',
        sha256: 'a'.repeat(64),
        page: 1,
        content: 'forbidden',
      },
    }),
  ).toThrow('invalid_input');
});
it('property: synthetic integer cents components and arbitrary deductions conserve exactly', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 100000000000n }),
      fc.bigInt({ min: 0n, max: 100000n }),
      (net, cut) => {
        const d = {
          ...base,
          gross_amount: stockFixed(net + cut),
          withholding_tax: stockFixed(cut),
          nhi_premium: '0',
          fee: '0',
          net_amount: stockFixed(net),
          components: [
            {
              code: '自由代碼',
              label: '無預設稅義',
              amount: stockFixed(net + cut),
              taxable: false,
            },
          ],
        };
        expect(validateDividend(d).net_amount).toBe(stockFixed(net));
      },
    ),
    { numRuns: 500 },
  );
});
