// SPDX-License-Identifier: AGPL-3.0-only
import { readStockPositions } from './securities-read.js';
import type { Transaction } from '@finmichi/db';
import type { BalanceReport, BalanceValuation } from './report-schemas.js';
import { readMarketFx, readMarketRuns } from './market-store.js';
import {
  findMarketRate,
  marketAge,
  decimalUnits,
  marketFixed,
  marketValue,
} from './market-math.js';
import { taipeiToday } from './ledger-lock.js';
export async function revalueBalance(
  sql: Transaction,
  r: BalanceReport,
  now = new Date(),
): Promise<BalanceReport> {
  const rows = await readMarketFx(sql, r.as_of),
    today = taipeiToday(now),
    values = new Map<string, BalanceValuation>();
  const stocks =
    r.base_currency === 'TWD'
      ? await readStockPositions(sql, r.ledger_id, r.as_of, now)
      : [];
  const flagged = new Set(
    (
      await sql<
        { id: string }[]
      >`SELECT id FROM items WHERE ledger_id=${r.ledger_id} AND securities`
    ).map((i) => i.id),
  );
  const own = new Map<string, bigint>();
  let assets = 0n,
    liabilities = 0n;
  for (const item of r.items) {
    const q =
      item.currency === r.base_currency
        ? null
        : findMarketRate(rows, item.currency, r.base_currency, r.as_of);
    const value = q
      ? marketValue(item.own_original_amount, q.rate)
      : item.own_book_amount;
    const natural =
      q && (item.kind === 'liability' || item.kind === 'equity')
        ? -decimalUnits(value, 2)
        : decimalUnits(value, 2);
    const holdings = stocks.filter((s) => s.item_id === item.id);
    const stockDelta = holdings.reduce(
      (a, s) => a + decimalUnits(s.market_amount, 2) - decimalUnits(s.cost, 2),
      0n,
    );
    const stockNatural = natural + stockDelta;
    const uncovered =
      flagged.has(item.id) &&
      decimalUnits(item.own_book_amount, 2) !==
        holdings.reduce((a, s) => a + decimalUnits(s.cost, 2), 0n);
    const age = q ? marketAge(q.rate_date, today, [], true) : null;
    const v: BalanceValuation = {
      own_market_amount: marketFixed(stockNatural, 2),
      market_amount: '0.00',
      unrealized_amount: '0.00',
      rate: q?.rate ?? null,
      rate_date: q?.rate_date ?? null,
      source: uncovered
        ? 'missing'
        : holdings.length
          ? holdings.some((h) => h.missing)
            ? 'missing'
            : holdings.every((h) => h.price_source === 'manual')
              ? 'manual'
              : 'market'
          : (q?.source ??
            (item.currency === r.base_currency ? 'book' : 'missing')),
      missing:
        (item.currency !== r.base_currency && !q) ||
        holdings.some((h) => h.missing) ||
        uncovered,
      stock_quotes: holdings,
      stale: (age?.stale ?? false) || holdings.some((h) => h.stale),
      estimated_days:
        (age?.estimated ?? false) || holdings.some((h) => h.estimated_days),
    };
    values.set(item.id, v);
    own.set(item.id, stockNatural);
    if (item.kind === 'asset') assets += stockNatural;
    else if (item.kind === 'liability') liabilities += stockNatural;
  }
  const children = new Map<string, string[]>();
  for (const item of r.items)
    if (item.parent_id)
      children.set(item.parent_id, [
        ...(children.get(item.parent_id) ?? []),
        item.id,
      ]);
  const visiting = new Set<string>(),
    done = new Set<string>();
  const roll = (id: string): bigint => {
    const v = values.get(id)!;
    if (done.has(id)) return decimalUnits(v.market_amount, 2);
    if (visiting.has(id)) throw new Error('Invalid account tree');
    visiting.add(id);
    let sum = own.get(id)!;
    for (const child of children.get(id) ?? []) {
      sum += roll(child);
      const c = values.get(child)!;
      v.missing ||= c.missing;
      v.stale ||= c.stale;
      v.estimated_days ||= c.estimated_days;
    }
    v.market_amount = marketFixed(sum, 2);
    const item = r.items.find((i) => i.id === id)!;
    v.unrealized_amount = marketFixed(
      sum - decimalUnits(item.book_amount, 2),
      2,
    );
    visiting.delete(id);
    done.add(id);
    return sum;
  };
  for (const item of r.items) {
    roll(item.id);
    item.valuation = values.get(item.id)!;
  }
  const net = assets - liabilities;
  return {
    ...r,
    market: {
      assets: marketFixed(assets, 2),
      liabilities: marketFixed(liabilities, 2),
      net_worth: marketFixed(net, 2),
      unrealized_amount: marketFixed(
        net - decimalUnits(r.totals.net_worth, 2),
        2,
      ),
      runs: await readMarketRuns(sql),
      stock_notice:
        r.base_currency === 'TWD'
          ? '股票以基準日或之前的手動價格優先估值；無行情時沿用帳面值。'
          : '股票功能目前僅支援本位幣為新臺幣的帳本',
    },
  };
}
