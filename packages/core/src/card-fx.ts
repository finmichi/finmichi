// SPDX-License-Identifier: AGPL-3.0-only
import type { FxRate } from './market-schemas.js';
import {
  decimalUnits,
  marketFixed,
  marketHalfUp,
  marketValue,
} from './market-math.js';
import { cardPeriod } from './finance-calendar.js';
import type { CardsResult } from './finance.js';
export type CardQuote = {
  rate: string;
  rate_date: string;
  source: 'bot' | 'bot-cross' | 'ledger';
};
export function cardQuote(
  rows: readonly FxRate[],
  ledgerRates: readonly {
    rate_date: string;
    from_currency: string;
    to_currency: string;
    rate: string;
  }[],
  from: string,
  to: string,
  asOf: string,
): CardQuote | null {
  const relevant = rows.filter(
    (r) => r.source === 'bot' && r.rate_date <= asOf,
  );
  for (const day of [...new Set(relevant.map((r) => r.rate_date))]
    .sort()
    .reverse()) {
    const leg = (currency: string, side: 'spot_sell' | 'spot_buy') => {
      if (currency === 'TWD') return 10000000000n;
      const value = relevant.find(
        (r) => r.rate_date === day && r.currency === currency,
      )?.[side];
      return value ? decimalUnits(value, 10) : null;
    };
    const a = leg(from, 'spot_sell'),
      b = leg(to, 'spot_buy');
    if (a !== null && a > 0n && b !== null && b > 0n) {
      const rounded = marketHalfUp(a * 10000n, b);
      if (rounded > 0n)
        return {
          rate: marketFixed(rounded, 4),
          rate_date: day,
          source: to === 'TWD' ? 'bot' : 'bot-cross',
        };
    }
  }
  const r = ledgerRates
    .filter(
      (r) =>
        r.from_currency === from && r.to_currency === to && r.rate_date <= asOf,
    )
    .sort((a, b) => b.rate_date.localeCompare(a.rate_date))[0];
  if (!r) return null;
  const rounded = marketHalfUp(decimalUnits(r.rate, 10), 1000000n);
  return rounded > 0n
    ? {
        rate: marketFixed(rounded, 4),
        rate_date: r.rate_date,
        source: 'ledger',
      }
    : null;
}
export const cardConvertedAmount = marketValue;
// One original-currency allocation shared by forecast and reminders. No conversion before capping.
export function cardAllocations(c: CardsResult['cards'][number]) {
  const balance = decimalUnits(c.current_balance, 6),
    debt = balance > 0n ? balance : 0n;
  let allocated = 0n;
  const result: {
    statement_on: string;
    due_on: string;
    amount: string;
    unclosed: boolean;
  }[] = [];
  for (const b of [...c.bills].sort(
    (a, b) => a.due_on.localeCompare(b.due_on) || a.to.localeCompare(b.to),
  )) {
    const unpaid = decimalUnits(b.unpaid, 6),
      delta = (unpaid < debt ? unpaid : debt) - allocated;
    if (delta > 0n) {
      result.push({
        statement_on: b.to,
        due_on: b.due_on,
        amount: marketFixed(delta, 6),
        unclosed: false,
      });
      allocated += delta;
    }
  }
  if (debt > allocated)
    result.push({
      statement_on: c.next_close,
      due_on: cardPeriod(c, c.next_close).due_on,
      amount: marketFixed(debt - allocated, 6),
      unclosed: true,
    });
  return result;
}
