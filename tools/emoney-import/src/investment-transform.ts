// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  replayStocks,
  stockUnits,
  stockFixed,
  stockDivide,
  type ReplayTrade,
} from '@finmichi/core/securities-math';
import { depositSchedule } from '@finmichi/core/deposit-math';
import { monthDate } from '@finmichi/core/finance-calendar';
import { depositSchema } from '@finmichi/core/deposit-schemas';
import { dateSchema, ImportError, type Row } from './schema.js';
import { sourceCurrency } from './transform.js';
import type { Bundle } from './bundle.js';
const itemRef = z.union([
  z.string().trim().min(1),
  z.strictObject({ create: z.string().trim().min(1).max(200) }),
]);
export const investmentMappingSchema = z.strictObject({
  securities_item: itemRef,
  settlement_item: itemRef,
  fee_item: itemRef,
  gain_item: itemRef,
  security_markets: z.record(z.string(), z.enum(['TWSE', 'TPEx'])).default({}),
  security_kinds: z.record(z.string(), z.enum(['stock', 'etf'])).default({}),
  deposit_items: z
    .array(
      z.strictObject({
        prefix: z.string().min(1),
        item: itemRef,
        payout_account: itemRef,
      }),
    )
    .default([]),
  deposit_interest_item: itemRef,
  deposit_defaults: z
    .strictObject({
      payout: z.enum(['at_maturity', 'monthly']).default('at_maturity'),
      auto_renew: z.boolean().default(true),
    })
    .default({ payout: 'at_maturity', auto_renew: true }),
  currencies: z.record(z.string(), z.string().regex(/^[A-Z]{3}$/)).default({}),
});
export type InvestmentMapping = z.infer<typeof investmentMappingSchema>;
export interface InvestmentItem {
  id: string;
  name: string;
  kind: string;
  currency: string;
  securities: boolean;
  non_operating: boolean;
  credit_card: boolean;
  loan: boolean;
  archived: boolean;
}
export interface InvestmentContext {
  items: InvestmentItem[];
  markets: { symbol: string; market: 'TWSE' | 'TPEx'; trade_date: string }[];
  transactions: { id: string; source_id: string | null }[];
  today: string;
  reusableItemIds?: string[];
}
export function slashDate(
  raw: string | undefined,
  code = 'stock_date_invalid',
) {
  const s = (raw ?? '').trim();
  if (
    !/^\d{4}\/\d{2}\/\d{2}$/.test(s) ||
    !dateSchema.safeParse(s.replaceAll('/', '-')).success
  )
    throw new ImportError(code);
  return s.replaceAll('/', '-');
}
function decimal(
  raw: string | undefined,
  places: number,
  code = 'invalid_amount',
) {
  const s = (raw ?? '').trim() || '0';
  try {
    if (stockUnits(s, places) < 0n) throw new Error();
    return stockFixed(stockUnits(s, places), places);
  } catch {
    throw new ImportError(code);
  }
}
export function roundedPrice(raw: string | undefined) {
  const s = (raw ?? '').trim();
  if (!/^\d{1,14}(?:\.\d{1,30})?$/.test(s))
    throw new ImportError('invalid_price');
  const [w = '0', f = ''] = s.split('.'),
    scale = 10n ** BigInt(f.length),
    exact = BigInt(w) * scale + BigInt(f || '0');
  const n = stockDivide(exact * 10000n, scale);
  return { price: stockFixed(n, 4), rounded: n * scale !== exact * 10000n };
}
function sourceKey(table: string, r: Row) {
  if (
    !/^\d+$/.test(r.ACCOUNT_ID?.trim() ?? '') ||
    !/^\d+$/.test(r.MAKE_NO?.trim() ?? '')
  )
    throw new ImportError('invalid_source_key');
  return `${table}:${r.ACCOUNT_ID!.trim()}:${r.MAKE_NO!.trim()}`;
}
export function transformInvestments(
  bundle: Bundle,
  mapping: InvestmentMapping,
  ctx: InvestmentContext,
) {
  const warnings: { code: string; key: string; difference?: string }[] = [],
    created: InvestmentItem[] = [],
    items = [...ctx.items],
    keys = new Set<string>();
  const unique = (key: string) => {
    if (keys.has(key)) throw new ImportError('duplicate_source_key', { key });
    keys.add(key);
    return key;
  };
  const createdRefs = new Map<string, InvestmentItem>();
  function resolve(
    ref: z.infer<typeof itemRef>,
    kind: string,
    nonOperating = false,
    currency = 'TWD',
  ) {
    let i: InvestmentItem | undefined;
    if (typeof ref === 'string') {
      const found = items.filter(
        (i) => i.id === ref || (i.name === ref && i.kind === kind),
      );
      if (found.length !== 1)
        throw new ImportError('mapping_item_invalid', { reference: ref });
      i = found[0];
    } else {
      const cacheKey = JSON.stringify([ref.create, kind, currency]);
      i = createdRefs.get(cacheKey);
      if (!i) {
        const found = items.filter(
          (item) => item.name === ref.create && item.kind === kind,
        );
        if (found.length) {
          const candidate = found[0]!;
          if (
            found.length !== 1 ||
            !ctx.reusableItemIds?.includes(candidate.id) ||
            candidate.non_operating !== nonOperating ||
            candidate.securities ||
            candidate.credit_card ||
            candidate.loan
          )
            throw new ImportError('mapping_item_invalid', {
              reference: ref.create,
            });
          i = candidate;
        } else {
          i = {
            id: randomUUID(),
            name: ref.create,
            kind,
            currency,
            securities: false,
            non_operating: nonOperating,
            credit_card: false,
            loan: false,
            archived: false,
          };
          items.push(i);
          created.push(i);
        }
        createdRefs.set(cacheKey, i);
      }
    }
    if (
      !i ||
      i.kind !== kind ||
      i.currency !== currency ||
      (nonOperating && !i.non_operating) ||
      i.archived
    )
      throw new ImportError('mapping_item_invalid', {
        reference: typeof ref === 'string' ? ref : ref.create,
      });
    return i;
  }
  const securityItem = resolve(mapping.securities_item, 'asset'),
    settlement = resolve(mapping.settlement_item, 'asset'),
    feeItem = resolve(mapping.fee_item, 'expense', true),
    gainItem = resolve(mapping.gain_item, 'income', true),
    interest = resolve(mapping.deposit_interest_item, 'income');
  if (securityItem.id === settlement.id || settlement.securities)
    throw new ImportError('mapping_item_invalid');
  const rawStocks = (bundle.tables.get('STOCK_DATA') ?? [])
    .map((r) => ({
      r,
      key: unique(sourceKey('STOCK_DATA', r)),
      date: slashDate(r.INOUT_DATE),
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (BigInt(a.r.MAKE_NO!) < BigInt(b.r.MAKE_NO!)
          ? -1
          : BigInt(a.r.MAKE_NO!) > BigInt(b.r.MAKE_NO!)
            ? 1
            : a.key.localeCompare(b.key)),
    );
  const securities: {
    id: string;
    symbol: string;
    name: string;
    market: 'TWSE' | 'TPEx';
    kind: 'stock' | 'etf';
    item_id: string;
    source_key: string;
  }[] = [];
  const trades: (ReplayTrade & {
    security_id: string;
    source_key: string;
    origin: 'emoney';
    source_transaction_id: string | null;
    transaction_id: null;
    note: string;
    settlement_item_id: string;
    expense_item_id: string;
    gain_item_id: string;
    gross: string;
    cost_removed: string;
    position_quantity: string;
    position_cost: string;
    realized_gain: string;
  })[] = [];
  const latestNames = new Map(
    rawStocks.map((x) => [x.r.STOCK_ID?.trim(), x.r.STOCK_NOTE?.trim()]),
  );
  const moneyKeys = new Map<string, Set<string>>();
  for (const r of bundle.tables.get('MYMONEY_DATA') ?? []) {
    const key = r.MAKE_NO?.trim(),
      data = r.DATA_KEY?.trim();
    if (!key || key === '0' || !data) continue;
    const values = moneyKeys.get(key) ?? new Set<string>();
    values.add(data);
    moneyKeys.set(key, values);
  }
  const transactionsBySource = new Map<string, typeof ctx.transactions>();
  for (const t of ctx.transactions)
    if (t.source_id) {
      const rows = transactionsBySource.get(t.source_id) ?? [];
      rows.push(t);
      transactionsBySource.set(t.source_id, rows);
    }
  const securitiesBySymbol = new Map<string, (typeof securities)[number]>(),
    sequences = new Map<string, number>(),
    groups = new Map<string, typeof trades>();
  for (const { r, key, date } of rawStocks) {
    const symbol = r.STOCK_ID?.trim() ?? '';
    if (!/^[A-Z0-9]{4,6}$/.test(symbol))
      throw new ImportError('invalid_security_symbol', { key });
    let sec = securitiesBySymbol.get(symbol);
    if (!sec) {
      const candidates = ctx.markets
        .filter((m) => m.symbol === symbol)
        .sort((a, b) => b.trade_date.localeCompare(a.trade_date));
      const latest = candidates[0],
        possible = new Set(
          candidates
            .filter((m) => m.trade_date === latest?.trade_date)
            .map((m) => m.market),
        );
      const market =
        mapping.security_markets[symbol] ??
        (possible.size === 1 ? latest?.market : undefined);
      if (!market) throw new ImportError('security_market_unknown', { symbol });
      const latestName = latestNames.get(symbol);
      sec = {
        id: randomUUID(),
        symbol,
        name:
          latestName ||
          bundle.tables
            .get('STOCK_ID_DATA')
            ?.find((x) => x.STOCK_ID?.trim() === symbol)
            ?.STOCK_NOTE?.trim() ||
          symbol,
        market,
        kind:
          mapping.security_kinds[symbol] ??
          (symbol.startsWith('00') ? 'etf' : 'stock'),
        item_id: securityItem.id,
        source_key: unique('STOCK_ID:' + symbol),
      };
      securities.push(sec);
      securitiesBySymbol.set(symbol, sec);
    }
    if (stockUnits(decimal(r.FINANCE_MOUNT, 6), 6) !== 0n)
      throw new ImportError('margin_not_supported', { key });
    const cls = r.STOCK_CLASS?.trim();
    if (cls !== '現股買進' && cls !== '現股賣出')
      throw new ImportError('stock_class_unsupported', { key, class: cls });
    const qtyIn = stockUnits(
        decimal(r.IN_QUANTY, 0, 'stock_quantity_invalid'),
        0,
      ),
      qtyOut = stockUnits(
        decimal(r.OUT_QUANTY, 0, 'stock_quantity_invalid'),
        0,
      );
    if (
      qtyIn > 0n === qtyOut > 0n ||
      (cls === '現股買進' && qtyIn === 0n) ||
      (cls === '現股賣出' && qtyOut === 0n)
    )
      throw new ImportError('stock_quantity_invalid', { key });
    const { price, rounded } = roundedPrice(r.INOUT_PRICE),
      amount = decimal(r.INOUT_MOUNT, 2),
      fee = decimal(r.INOUT_CHARGE, 2),
      tax = cls === '現股賣出' ? decimal(r.OUT_TAX, 2) : '0.00';
    if (rounded) warnings.push({ code: 'stock_price_rounded', key });
    const type =
      cls === '現股賣出'
        ? 'sell'
        : stockUnits(price, 4) > 0n
          ? 'buy'
          : stockUnits(amount) === 0n
            ? 'stock_dividend'
            : null;
    if (!type) throw new ImportError('invalid_price', { key });
    const linkKeys =
      moneyKeys.get(r.MONEY_MAKE_NO?.trim() ?? '') ?? new Set<string>();
    const links = [
      ...new Map(
        [...linkKeys]
          .flatMap((key) => transactionsBySource.get(key) ?? [])
          .map((t) => [t.id, t]),
      ).values(),
    ];
    if (links.length > 1)
      throw new ImportError('source_transaction_ambiguous', { key });
    const quantity = (qtyIn || qtyOut).toString(),
      gross = stockDivide(BigInt(quantity) * stockUnits(price, 4), 100n),
      expected = gross + (type === 'buy' ? stockUnits(fee) : 0n);
    if (stockUnits(amount) !== expected)
      warnings.push({
        code: 'stock_amount_mismatch',
        key,
        difference: stockFixed(stockUnits(amount) - expected),
      });
    const seqKey = sec.id + ':' + date,
      sequence = (sequences.get(seqKey) ?? 0) + 1;
    sequences.set(seqKey, sequence);
    const trade: (typeof trades)[number] = {
      id: randomUUID(),
      security_id: sec.id,
      source_key: key,
      origin: 'emoney',
      source_transaction_id: links[0]?.id ?? null,
      transaction_id: null,
      trade_type: type,
      trade_date: date,
      sequence,
      quantity,
      quantity_after: null,
      price: type === 'stock_dividend' ? '0.0000' : price,
      fee: type === 'stock_dividend' ? '0.00' : fee,
      tax: type === 'stock_dividend' ? '0.00' : tax,
      cost_mode: null,
      cost_after: null,
      cash_amount: null,
      note: r.STOCK_MEMO?.trim() ?? '',
      settlement_item_id: settlement.id,
      expense_item_id: feeItem.id,
      gain_item_id: gainItem.id,
      gross: '0.00',
      cost_removed: '0.00',
      position_quantity: '0',
      position_cost: '0.00',
      realized_gain: '0.00',
    };
    trades.push(trade);
    const group = groups.get(sec.id) ?? [];
    group.push(trade);
    groups.set(sec.id, group);
  }
  for (const s of securities) {
    const rows = groups.get(s.id) ?? [],
      byId = new Map(rows.map((t) => [t.id, t]));
    try {
      for (const step of replayStocks(rows)) {
        const t = byId.get(step.trade_id)!;
        Object.assign(t, {
          gross: step.gross,
          cost_removed: step.cost_removed,
          position_quantity: step.quantity_after,
          position_cost: step.cost_after,
          realized_gain: step.realized_gain,
        });
      }
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'insufficient_shares')
        throw new ImportError('insufficient_shares', {
          symbol: s.symbol,
          ...('details' in e ? (e.details as object) : {}),
        });
      throw e;
    }
  }
  const suggestedPrefixes = new Set<string>();
  const deposits = (bundle.tables.get('REGULAR_DATA') ?? []).map((r) => {
    const key = unique(sourceKey('REGULAR_DATA', r)),
      bank = r.BANK_NAME?.trim() ?? '',
      prefix = bank.split('-').slice(0, 2).join('-') + '-';
    suggestedPrefixes.add(prefix);
    const matches = mapping.deposit_items.filter((m) =>
      bank.startsWith(m.prefix),
    );
    if (matches.length !== 1)
      throw new ImportError(
        matches.length ? 'deposit_item_ambiguous' : 'deposit_item_unmapped',
        { key, suggested_prefix: prefix },
      );
    const m = matches[0]!,
      currencyNote = r.CURRENCY_NOTE?.trim() ?? '',
      currency = sourceCurrency(currencyNote, mapping.currencies);
    if (!currency)
      throw new ImportError('unknown_currency', {
        key,
        currency_note: currencyNote,
      });
    for (const ref of [m.item, m.payout_account])
      if (
        typeof ref === 'string' &&
        items.some(
          (i) =>
            (i.id === ref || (i.kind === 'asset' && i.name === ref)) &&
            i.currency !== currency,
        )
      )
        throw new ImportError('deposit_currency_mismatch', { key });
    const item = resolve(m.item, 'asset', false, currency),
      payout = resolve(m.payout_account, 'asset', false, currency);
    if (
      item.securities ||
      item.id === securityItem.id ||
      item.credit_card ||
      item.loan ||
      payout.securities ||
      payout.id === securityItem.id
    )
      throw new ImportError('mapping_item_invalid', { key });
    const start = slashDate(r.START_DATE, 'deposit_term_invalid'),
      end = slashDate(r.END_DATE, 'deposit_term_invalid');
    const months =
      (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
      Number(end.slice(5, 7)) -
      Number(start.slice(5, 7));
    const monthly = months > 0 && monthDate(start, months) === end;
    if (!/^\d{1,3}(?:\.\d{1,6})?$/.test(r.PROFIT_RATIO?.trim() ?? ''))
      throw new ImportError('invalid_amount', { key });
    const yearRate = decimal(r.PROFIT_RATIO, 6),
      principal = decimal(r.SAVE_MOUNT, 2);
    const data = depositSchema.parse({
      item_id: item.id,
      payout_account_id: payout.id,
      interest_item_id: interest.id,
      bank,
      principal,
      annual_rate: yearRate,
      start_on: start,
      maturity_on: end,
      interest_basis: monthly ? 'monthly' : 'daily',
      ...mapping.deposit_defaults,
      note:
        (r.DATA_NOTE?.trim() ?? '') +
        (r.PROFIT_TYPE?.trim() === '機動'
          ? `\n機動利率（轉入時 ${yearRate.replace(/\.?0+$/, '')}%）`
          : ''),
    });
    depositSchedule(data);
    const periods: Record<string, number> = {
      一年: 12,
      二年: 24,
      兩年: 24,
      三年: 36,
      六個月: 6,
      三個月: 3,
      一個月: 1,
      九個月: 9,
    };
    if (!monthly || periods[r.SAVE_PERIODS?.trim() ?? ''] !== months)
      warnings.push({ code: 'deposit_period_mismatch', key });
    if (end < ctx.today)
      warnings.push({ code: 'deposit_already_matured', key });
    return {
      ...data,
      id: randomUUID(),
      source_key: key,
      status: end < ctx.today ? ('matured' as const) : ('active' as const),
      renewed_from_id: null,
    };
  });
  return {
    securities,
    trades,
    deposits,
    created_items: created,
    securities_item: securityItem.id,
    previous_securities: securityItem.securities,
    warnings,
    suggested_deposit_mapping: [...suggestedPrefixes].map((prefix) => ({
      prefix,
      item: '<科目>',
      payout_account: '<科目>',
    })),
  };
}
export type InvestmentPlan = ReturnType<typeof transformInvestments>;
