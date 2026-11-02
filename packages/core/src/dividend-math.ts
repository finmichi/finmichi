// SPDX-License-Identifier: AGPL-3.0-only
import { DomainError, valid } from './catalog.js';
import { dividendSchema, type DividendInput } from './dividend-schemas.js';
import { stockUnits } from './securities-math.js';
/** Pure shared validation: future draft_dividend must call the same contract. */
export function validateDividend(raw: unknown): DividendInput {
  if (
    raw &&
    typeof raw === 'object' &&
    (!('pay_date' in raw) || !(raw as { pay_date?: unknown }).pay_date)
  )
    throw new DomainError('pay_date_required', 400);
  const d = valid(dividendSchema, raw),
    gross = stockUnits(d.gross_amount),
    sum = d.components.reduce((s, c) => s + stockUnits(c.amount), 0n);
  if (
    sum !== gross ||
    (gross === 0n ? d.components.length !== 0 : d.components.length === 0) ||
    stockUnits(d.net_amount) !==
      gross -
        stockUnits(d.withholding_tax) -
        stockUnits(d.nhi_premium) -
        stockUnits(d.fee)
  )
    throw new DomainError('dividend_amount_mismatch', 400);
  if (gross === 0n && BigInt(d.stock_shares) === 0n)
    throw new DomainError('dividend_empty', 400);
  return d;
}
