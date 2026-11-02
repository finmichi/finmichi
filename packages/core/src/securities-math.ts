// SPDX-License-Identifier: AGPL-3.0-only
import type { StockTradeInput } from './securities-schemas.js';
export class StockCalculationError extends Error {
  constructor(
    public readonly code:
      'invalid_input' | 'insufficient_shares' | 'adjust_cost_required',
    public readonly details?: { date: string; shortfall?: string },
  ) {
    super(code);
  }
}
export function stockUnits(value: string, places = 2): bigint {
  if (!/^-?\d+(?:\.\d+)?$/.test(value))
    throw new StockCalculationError('invalid_input');
  const negative = value.startsWith('-'),
    [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  if (fraction.length > places && /[1-9]/.test(fraction.slice(places)))
    throw new StockCalculationError('invalid_input');
  const n =
    BigInt(whole) * 10n ** BigInt(places) +
    BigInt(fraction.slice(0, places).padEnd(places, '0') || '0');
  return negative ? -n : n;
}
export function stockFixed(n: bigint, places = 2) {
  const sign = n < 0n ? '-' : '',
    s = (n < 0n ? -n : n).toString().padStart(places + 1, '0');
  return places
    ? sign + s.slice(0, -places) + '.' + s.slice(-places)
    : sign + s;
}
export function stockDivide(n: bigint, d: bigint) {
  if (d <= 0n) throw new StockCalculationError('invalid_input');
  const a = n < 0n ? -n : n,
    rounded = (a + d / 2n) / d;
  return n < 0n ? -rounded : rounded;
}
export interface StockValues {
  trade_type: StockTradeInput['trade_type'];
  quantity: string | null;
  quantity_after: string | null;
  price: string;
  fee: string;
  tax: string;
  cost_mode: 'keep' | 'set_cost' | 'cash_return' | null;
  cost_after: string | null;
  cash_amount: string | null;
}
export interface ReplayTrade extends StockValues {
  id: string;
  trade_date: string;
  sequence: number;
}
export interface StockStep {
  trade_id: string;
  trade_date: string;
  sequence: number;
  quantity_before: string;
  cost_before: string;
  quantity_after: string;
  cost_after: string;
  gross: string;
  cost_removed: string;
  realized_gain: string;
  gain_before_fees: string;
  average_cost: string;
}
export function stockValues(t: StockTradeInput): StockValues {
  return {
    trade_type: t.trade_type,
    quantity: t.trade_type === 'adjust' ? null : t.quantity,
    quantity_after: t.trade_type === 'adjust' ? t.quantity_after : null,
    price: t.trade_type === 'buy' || t.trade_type === 'sell' ? t.price : '0',
    fee: t.trade_type === 'buy' || t.trade_type === 'sell' ? t.fee : '0',
    tax: t.trade_type === 'buy' || t.trade_type === 'sell' ? t.tax : '0',
    cost_mode: t.trade_type === 'adjust' ? t.cost_mode : null,
    cost_after: t.trade_type === 'adjust' ? (t.cost_after ?? null) : null,
    cash_amount: t.trade_type === 'adjust' ? (t.cash_amount ?? null) : null,
  };
}
export function replayStocks(input: readonly ReplayTrade[]): StockStep[] {
  let quantity = 0n,
    cost = 0n;
  return [...input]
    .sort(
      (a, b) =>
        a.trade_date.localeCompare(b.trade_date) || a.sequence - b.sequence,
    )
    .map((t) => {
      const beforeQuantity = quantity,
        beforeCost = cost,
        q = BigInt(t.quantity ?? '0'),
        fee = stockUnits(t.fee),
        tax = stockUnits(t.tax);
      if (
        (t.trade_type !== 'adjust' && q <= 0n) ||
        stockUnits(t.price, 6) < 0n ||
        fee < 0n ||
        tax < 0n
      )
        throw new StockCalculationError('invalid_input');
      const gross =
        t.trade_type === 'buy' || t.trade_type === 'sell'
          ? stockDivide(q * stockUnits(t.price, 6), 10000n)
          : 0n;
      let removed = 0n,
        realized = 0n,
        gain = 0n;
      if (t.trade_type === 'buy') {
        quantity += q;
        cost += gross + fee + tax;
      } else if (t.trade_type === 'sell') {
        if (q > quantity)
          throw new StockCalculationError('insufficient_shares', {
            date: t.trade_date,
            shortfall: (q - quantity).toString(),
          });
        if (!q) throw new StockCalculationError('invalid_input');
        removed = q === quantity ? cost : stockDivide(cost * q, quantity);
        quantity -= q;
        cost -= removed;
        gain = gross - removed;
        realized = gain - fee - tax;
      } else if (t.trade_type === 'stock_dividend') quantity += q;
      else {
        quantity = BigInt(t.quantity_after ?? '0');
        if (t.cost_mode === 'keep') {
          if (!quantity)
            throw new StockCalculationError('adjust_cost_required');
        } else if (t.cost_mode === 'set_cost') {
          cost = stockUnits(t.cost_after ?? '0');
          gain = realized = cost - beforeCost;
          // cost_removed is reserved for sale-cost reporting; adjustments use cost_after - cost_before.
        } else if (t.cost_mode === 'cash_return') {
          const cash = stockUnits(t.cash_amount ?? '0');
          const reduction = cash < cost ? cash : cost;
          cost -= reduction;
          gain = realized = cash - reduction;
        } else throw new StockCalculationError('invalid_input');
        if (quantity < 0n || cost < 0n || (!quantity && cost))
          throw new StockCalculationError('adjust_cost_required');
      }
      return {
        trade_id: t.id,
        trade_date: t.trade_date,
        sequence: t.sequence,
        quantity_before: beforeQuantity.toString(),
        cost_before: stockFixed(beforeCost),
        quantity_after: quantity.toString(),
        cost_after: stockFixed(cost),
        gross: stockFixed(gross),
        cost_removed: stockFixed(removed),
        realized_gain: stockFixed(realized),
        gain_before_fees: stockFixed(gain),
        average_cost: quantity
          ? stockFixed(stockDivide(cost * 100n, quantity), 4)
          : '0.0000',
      };
    });
}

// Source belongs to the current uninterrupted position, not the lifetime of a symbol.
export function holdingOrigin(
  rows: readonly {
    origin: 'app' | 'emoney';
    position_quantity: string;
    trade_date: string;
    sequence: number;
  }[],
): 'app' | 'emoney' | 'mixed' {
  const sources = new Set<'app' | 'emoney'>();
  let previousZero = false;
  for (const r of [...rows].sort(
    (a, b) =>
      a.trade_date.localeCompare(b.trade_date) || a.sequence - b.sequence,
  )) {
    if (previousZero) sources.clear();
    sources.add(r.origin);
    previousZero = BigInt(r.position_quantity) === 0n;
  }
  return sources.size > 1 ? 'mixed' : sources.has('emoney') ? 'emoney' : 'app';
}
