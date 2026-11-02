// SPDX-License-Identifier: AGPL-3.0-only
import type { DepositInput } from './deposit-schemas.js';
import { stockUnits, stockFixed, stockDivide } from './securities-math.js';
import { monthDate, addDays } from './finance-calendar.js';
export class DepositCalculationError extends Error {
  constructor(
    public readonly code:
      'deposit_term_invalid' | 'deposit_amount_invalid' | 'invalid_input',
  ) {
    super(code);
  }
}
export const depositDays = (a: string, b: string) =>
  (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000;
export function depositSchedule(d: DepositInput) {
  const principal = stockUnits(d.principal),
    rate = stockUnits(d.annual_rate, 6),
    days = depositDays(d.start_on, d.maturity_on);
  if (principal <= 0n || rate < 0n || rate > 100000000n)
    throw new DepositCalculationError('invalid_input');
  const months =
    (Number(d.maturity_on.slice(0, 4)) - Number(d.start_on.slice(0, 4))) * 12 +
    Number(d.maturity_on.slice(5, 7)) -
    Number(d.start_on.slice(5, 7));
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    (d.interest_basis === 'monthly' &&
      (months < 1 || monthDate(d.start_on, months) !== d.maturity_on))
  )
    throw new DepositCalculationError('deposit_term_invalid');
  const cumulative = (date: string, k: number) =>
    stockDivide(
      principal *
        rate *
        BigInt(
          d.interest_basis === 'monthly' ? k : depositDays(d.start_on, date),
        ),
      100000000n * BigInt(d.interest_basis === 'monthly' ? 12 : 365),
    );
  const total = cumulative(d.maturity_on, months),
    periods: { period_no: number; due_on: string; interest: string }[] = [];
  if (d.payout === 'at_maturity')
    periods.push({
      period_no: 1,
      due_on: d.maturity_on,
      interest: stockFixed(total),
    });
  else {
    let prev = 0n;
    for (let k = 1; ; k++) {
      const date = monthDate(d.start_on, k);
      const due = date < d.maturity_on ? date : d.maturity_on;
      const cum = due === d.maturity_on ? total : cumulative(due, k);
      periods.push({
        period_no: k,
        due_on: due,
        interest: stockFixed(cum - prev),
      });
      prev = cum;
      if (due === d.maturity_on) break;
    }
  }
  return { total_interest: stockFixed(total), months, days, periods };
}
export function depositNet(d: {
  gross_interest: string;
  withholding_tax: string;
  nhi_premium: string;
}) {
  const gross = stockUnits(d.gross_interest),
    tax = stockUnits(d.withholding_tax),
    nhi = stockUnits(d.nhi_premium);
  if (gross < 0n || tax < 0n || nhi < 0n || tax + nhi > gross)
    throw new DepositCalculationError('deposit_amount_invalid');
  return stockFixed(gross - tax - nhi);
}
export function renewedTerm(d: DepositInput) {
  const s = depositSchedule(d);
  return {
    start_on: d.maturity_on,
    maturity_on:
      d.interest_basis === 'monthly'
        ? monthDate(d.maturity_on, s.months)
        : addDays(d.maturity_on, s.days),
  };
}
