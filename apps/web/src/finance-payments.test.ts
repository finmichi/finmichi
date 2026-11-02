// SPDX-License-Identifier: AGPL-3.0-only
import { foreignCardPayment } from './finance-payments';
import type { CardsResult } from '@finmichi/core';
import { it, expect } from 'vitest';
import {
  cardPaymentReason,
  loanPayment,
  normalizePaymentAmount,
  paymentInput,
  recentLoanPeriods,
  cardNextDates,
} from './finance-payments';
import { amortize } from '@finmichi/core/finance-calendar';
const s = {
  item_id: '00000000-0000-4000-8000-000000000001',
  payment_account_id: '00000000-0000-4000-8000-000000000002',
  interest_item_id: '00000000-0000-4000-8000-000000000003',
  principal: '1000',
  annual_rate: '0',
  term_months: 3,
  first_payment_on: '2027-01-01',
  method: 'annuity' as const,
};
it('rev1.2 zero-rate payment omits zero interest; small zero-payment period is empty', () => {
  const row = amortize(s)[0]!;
  const input = loanPayment(s, row, '2027-01-01');
  expect(input.entries).toEqual([
    { item_id: s.payment_account_id, amount: '-333.33' },
    { item_id: s.item_id, amount: '333.33' },
  ]);
  const zero = amortize({ ...s, principal: '0.06', term_months: 12 })[0]!;
  expect(zero.payment).toBe('0.00');
  expect(loanPayment(s, zero, '2027-01-01').entries).toEqual([]);
});
it('positive-rate payment preserves three nonzero balanced entries', () => {
  const row = amortize({ ...s, annual_rate: '2.1' })[0]!;
  expect(loanPayment(s, row, '2027-01-01').entries).toHaveLength(3);
});
it('credit payment disabled without account, when zero, or with negative overpayment', () => {
  const c = {
    item_id: s.item_id,
    statement_day: 15,
    due_day: 5,
    due_month_offset: 1 as const,
    payment_account_id: s.payment_account_id,
    credit_limit: null,
  };
  expect(cardPaymentReason(c, '100')).toBeNull();
  for (const v of ['0', '-100'])
    expect(cardPaymentReason(c, v)).toBe('已繳清，無需繳款');
  expect(cardPaymentReason({ ...c, payment_account_id: null }, '100')).toBe(
    '請先設定繳款帳戶',
  );
});
it('interest-only period omits zero principal and keeps two balanced entries', () => {
  const row = {
    period: 1,
    due_on: '2027-01-01',
    opening: '1000.00',
    principal: '0.00',
    interest: '1.00',
    payment: '1.00',
    closing: '1000.00',
  };
  expect(loanPayment(s, row, '2027-01-01').entries).toEqual([
    { item_id: s.payment_account_id, amount: '-1' },
    { item_id: s.interest_item_id, amount: '1' },
  ]);
});
it('payment amounts remove only trailing zeros without floating point or rounding', () => {
  const values = [
    '1300.000000',
    '-1300.000000',
    '0.060000',
    '-0.060000',
    '99999999999999.120000',
    '1.234567',
    '1000',
  ];
  expect(values.map(normalizePaymentAmount)).toEqual([
    '1300',
    '-1300',
    '0.06',
    '-0.06',
    '99999999999999.12',
    '1.234567',
    '1000',
  ]);
  expect(
    paymentInput(
      values.map((amount) => ({ item_id: s.item_id, amount })),
      '2026-10-19',
    ).entries.map((e) => e.amount),
  ).toEqual(values.map(normalizePaymentAmount));
});
it('recent schedule shows current and next, with first/last boundary cases', () => {
  const schedule = amortize(s);
  expect(
    recentLoanPeriods(schedule, '2026-12-01').map((r) => r.period),
  ).toEqual([1, 2]);
  expect(
    recentLoanPeriods(schedule, '2027-02-01').map((r) => r.period),
  ).toEqual([2, 3]);
  expect(
    recentLoanPeriods(schedule, '2027-04-01').map((r) => r.period),
  ).toEqual([3]);
  expect(recentLoanPeriods([], '2027-01-01')).toEqual([]);
});
it('card dates distinguish billed due date from the next close, including future bill fallback', () => {
  const card = {
    item_id: s.item_id,
    payment_account_id: s.payment_account_id,
    credit_limit: null,
    statement_day: 5,
    due_day: 20,
    due_month_offset: 0 as const,
    next_due: '2026-10-20',
    next_close: '2026-11-05',
    bills: [{ to: '2026-10-05', due_on: '2026-10-20' }],
  };
  expect(cardNextDates(card)).toBe(
    '下次繳款 2026-10-20（10-05 帳單）・下次結帳 2026-11-05',
  );
  expect(cardNextDates({ ...card, next_due: '2026-11-20', bills: [] })).toBe(
    '下次繳款 2026-11-20（11-05 帳單）・下次結帳 2026-11-05',
  );
});

it('foreign card prefill uses quote, leaves missing base amount empty, same currency stays transfer', () => {
  const c = {
    item_id: s.item_id,
    payment_account_id: s.payment_account_id,
    currency: 'USD',
    payment_currency: 'TWD',
    payment_quote: { rate: '32.1235', source: 'bot', rate_date: '2026-10-23' },
  } as CardsResult['cards'][number];
  const p = foreignCardPayment(c, '100.01', '2026-10-23');
  expect(p.input.entries.map((e) => e.amount)).toEqual(['-3212.67', '100.01']);
  expect(p.mode).toBe('advanced');
  expect(p.notice).toContain('預估匯率 32.1235');
  const missing = foreignCardPayment(
    { ...c, payment_quote: null },
    '100',
    '2026-10-23',
  );
  expect(missing.input.entries.map((e) => e.amount)).toEqual(['', '100']);
  expect(missing.notice).toContain('缺少預估匯率');
  const same = foreignCardPayment(
    { ...c, payment_currency: 'USD' },
    '100.000000',
    '2026-10-23',
  );
  expect(same.input.entries.map((e) => e.amount)).toEqual(['-100', '100']);
  expect(same.mode).toBe('transfer');
  expect(same.notice).toBeUndefined();
});
