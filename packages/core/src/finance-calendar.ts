// SPDX-License-Identifier: AGPL-3.0-only
import type { CardSettings, LoanSettings } from './finance-schemas.js';
import { scaled, centsText, loanSettingsSchema } from './finance-schemas.js';
export function monthDate(
  anchor: string,
  offset: number,
  day = Number(anchor.slice(8)),
) {
  const y = Number(anchor.slice(0, 4)),
    m = Number(anchor.slice(5, 7)) - 1 + offset;
  const d = new Date(0);
  d.setUTCFullYear(y, m + 1, 0);
  d.setUTCHours(0, 0, 0, 0);
  const last = d.getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
export function addDays(date: string, days: number) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function cardPeriod(s: CardSettings, month: string) {
  const close = monthDate(month, 0, s.statement_day);
  return {
    from: addDays(monthDate(month, -1, s.statement_day), 1),
    to: close,
    due_on: monthDate(month, s.due_month_offset, s.due_day),
  };
}
const halfUp = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);
export interface LoanPeriod {
  period: number;
  due_on: string;
  opening: string;
  principal: string;
  interest: string;
  payment: string;
  closing: string;
}
export function amortize(input: LoanSettings): LoanPeriod[] {
  const s = loanSettingsSchema.parse(input),
    p = scaled(s.principal),
    n = BigInt(s.term_months),
    rate = scaled(s.annual_rate, 6),
    q = 1200000000n;
  let payment = 0n;
  if (s.method === 'annuity' && rate > 0n) {
    const power = (q + rate) ** n,
      denominator = power - q ** n;
    payment = halfUp(p * rate * power, q * denominator);
  }
  let balance = p;
  return Array.from({ length: s.term_months }, (_, i) => {
    const opening = balance,
      interest = halfUp(opening * rate, q);
    let principal =
      s.method === 'equal_principal' || rate === 0n
        ? p / n
        : payment - interest;
    if (principal < 0n) principal = 0n;
    if (principal > balance || i === s.term_months - 1) principal = balance;
    balance -= principal;
    return {
      period: i + 1,
      due_on: monthDate(s.first_payment_on, i),
      opening: centsText(opening),
      principal: centsText(principal),
      interest: centsText(interest),
      payment: centsText(principal + interest),
      closing: centsText(balance),
    };
  });
}
