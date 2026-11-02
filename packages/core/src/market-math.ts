// SPDX-License-Identifier: AGPL-3.0-only
import { dateSchema } from './transaction-schemas.js';
import {
  MarketDataError,
  type FxRate,
  type MarketQuote,
  type MarketDay,
  type MarketPrice,
} from './market-schemas.js';
export const absMarket = (n: bigint) => (n < 0n ? -n : n);
export function decimalUnits(v: string, places: number): bigint {
  if (
    typeof v !== 'string' ||
    v.length > 80 ||
    !new RegExp(`^-?\\d+(?:\\.\\d{1,${places}})?$`).test(v)
  )
    throw new MarketDataError('market_data_invalid');
  const neg = v.startsWith('-'),
    [a, b = ''] = (neg ? v.slice(1) : v).split('.');
  return (
    (neg ? -1n : 1n) *
    (BigInt(a!) * 10n ** BigInt(places) + BigInt(b.padEnd(places, '0')))
  );
}
export function marketFixed(n: bigint, places: number) {
  const a = absMarket(n),
    s = 10n ** BigInt(places);
  return `${n < 0n ? '-' : ''}${a / s}.${String(a % s).padStart(places, '0')}`;
}
export function marketHalfUp(n: bigint, d: bigint) {
  if (d <= 0n) throw new MarketDataError('market_data_invalid');
  const a = absMarket(n);
  return (n < 0n ? -1n : 1n) * (a / d + ((a % d) * 2n >= d ? 1n : 0n));
}
// Twice the exact midpoint, in 10-place units: no premature midpoint rounding.
function midpoint(r: FxRate) {
  const a = r.spot_buy === null ? null : decimalUnits(r.spot_buy, 10),
    b = r.spot_sell === null ? null : decimalUnits(r.spot_sell, 10);
  if (a === null && b === null) return null;
  const n = a === null ? b! * 2n : b === null ? a * 2n : a + b;
  return n > 0n ? n : null;
}
export function findMarketRate(
  rows: readonly FxRate[],
  from: string,
  to: string,
  asOf: string,
): MarketQuote | null {
  if (!dateSchema.safeParse(asOf).success)
    throw new MarketDataError('market_data_invalid');
  if (from === to) return null;
  const relevant = rows.filter(
    (r) =>
      r.source === 'bot' &&
      r.rate_date <= asOf &&
      (r.currency === from || r.currency === to),
  );
  const days = [...new Set(relevant.map((r) => r.rate_date))].sort().reverse();
  for (const day of days) {
    const get = (c: string) =>
      c === 'TWD'
        ? 20_000_000_000n
        : midpoint(
            relevant.find((r) => r.currency === c && r.rate_date === day) ?? {
              currency: c,
              rate_date: day,
              source: 'bot',
              spot_buy: null,
              spot_sell: null,
              cash_buy: null,
              cash_sell: null,
            },
          );
    const a = get(from),
      b = get(to);
    if (a !== null && b !== null)
      return {
        rate: marketFixed(marketHalfUp(a * 10_000_000_000n, b), 10),
        rate_date: day,
        source: to === 'TWD' ? 'bot' : 'bot-cross',
      };
  }
  return null;
}
export function marketValue(amount: string, rate: string) {
  return marketFixed(
    marketHalfUp(
      decimalUnits(amount, 6) * decimalUnits(rate, 10),
      100_000_000_000_000n,
    ),
    2,
  );
}
export function marketDayAfter(day: string) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
export const isWeekday = (day: string) => {
  const d = new Date(day + 'T00:00:00Z').getUTCDay();
  return d !== 0 && d !== 6;
};
export function marketAge(
  day: string,
  today: string,
  calendar: readonly MarketDay[] = [],
  fx = false,
) {
  if (
    !dateSchema.safeParse(day).success ||
    !dateSchema.safeParse(today).success
  )
    throw new MarketDataError('market_data_invalid');
  const map = new Map(calendar.map((d) => [d.date, d.is_trading_day]));
  let days = 0,
    estimated = fx;
  // Only completed dates; today's session has not finished for this comparison.
  for (let d = marketDayAfter(day); d < today; d = marketDayAfter(d)) {
    const trading = fx ? undefined : map.get(d);
    if (trading === undefined) estimated = true;
    if (trading ?? isWeekday(d)) days++;
  }
  return { days, stale: days > 3, estimated };
}
export function valueHoldings(
  holdings: readonly {
    market: 'TWSE' | 'TPEx';
    symbol: string;
    quantity: string;
  }[],
  prices: readonly MarketPrice[],
  asOf: string,
) {
  if (!dateSchema.safeParse(asOf).success)
    throw new MarketDataError('market_data_invalid');
  return holdings.map((h) => {
    if (!/^\d{1,100}$/.test(h.quantity))
      throw new MarketDataError('market_data_invalid');
    const rows = prices
      .filter(
        (p) =>
          p.market === h.market &&
          p.symbol === h.symbol &&
          p.trade_date <= asOf,
      )
      .sort((a, b) => b.trade_date.localeCompare(a.trade_date));
    const p = rows[0];
    return {
      ...h,
      market_amount: p
        ? marketFixed(
            marketHalfUp(
              BigInt(h.quantity) * decimalUnits(p.close, 6),
              10_000n,
            ),
            2,
          )
        : null,
      price_date: p?.trade_date ?? null,
      price: p?.close ?? null,
    };
  });
}
