// SPDX-License-Identifier: AGPL-3.0-only
import { dateSchema } from './transaction-schemas.js';
import type { Database, Transaction } from '@finmichi/db';
import { ownedLedger, valid, DomainError } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import {
  holdingsQuerySchema,
  realizedQuerySchema,
  stockHistoryQuerySchema,
} from './securities-schemas.js';
import { requireStockLedger, readSecurity } from './securities.js';
import {
  stockUnits,
  stockFixed,
  stockDivide,
  holdingOrigin,
} from './securities-math.js';
import { valueHoldings, marketAge } from './market-math.js';
import { taipeiToday } from './ledger-lock.js';
import type { MarketPrice, MarketDay } from './market-schemas.js';
export async function readStockPositions(
  sql: Transaction,
  ledger: string,
  asOf: string,
  now = new Date(),
) {
  const rows = await sql<
    {
      id: string;
      item_id: string;
      name: string;
      symbol: string;
      market: 'TWSE' | 'TPEx';
      kind: 'stock' | 'etf';
      archived: boolean;
      quantity: string;
      cost: string;
      realized_gain: string;
    }[]
  >`
    SELECT s.id,s.item_id,s.name,s.symbol,s.market,s.kind,s.archived,
      coalesce(p.position_quantity,0)::text quantity,coalesce(p.position_cost,0)::text cost,
      coalesce((SELECT sum(realized_gain) FROM security_trades WHERE security_id=s.id AND ledger_id=s.ledger_id AND trade_date<=${asOf}),0)::text realized_gain
    FROM securities s LEFT JOIN LATERAL(SELECT position_quantity,position_cost FROM security_trades t WHERE t.security_id=s.id AND t.ledger_id=s.ledger_id AND trade_date<=${asOf} ORDER BY t.trade_date DESC,t.sequence DESC LIMIT 1)p ON true WHERE s.ledger_id=${ledger} ORDER BY s.market,s.symbol`;
  const prices = await sql<
    MarketPrice[]
  >`SELECT DISTINCT ON(market,symbol) market,symbol,trade_date::text,close::text,source FROM market_prices WHERE trade_date<=${asOf} ORDER BY market,symbol,trade_date DESC`;
  const manual = await sql<
    {
      market: 'TWSE' | 'TPEx';
      symbol: string;
      price_date: string;
      price: string;
    }[]
  >`SELECT DISTINCT ON(market,symbol) market,symbol,price_date::text,price::text FROM manual_prices WHERE ledger_id=${ledger} AND price_date<=${asOf} ORDER BY market,symbol,price_date DESC`;
  const calendar = await sql<
    MarketDay[]
  >`SELECT date::text,market,is_trading_day,source FROM market_calendar WHERE date<=${taipeiToday(now)} ORDER BY date`;
  const origins = await sql<
    {
      security_id: string;
      origin: 'app' | 'emoney';
      position_quantity: string;
      trade_date: string;
      sequence: number;
    }[]
  >`SELECT security_id,origin,position_quantity::text,trade_date::text,sequence FROM security_trades WHERE ledger_id=${ledger} AND trade_date<=${asOf} ORDER BY security_id,trade_date,sequence`;
  return rows.map((r) => {
    const m = manual.find(
      (p) => p.market === r.market && p.symbol === r.symbol,
    );
    const selected = m
      ? [
          {
            market: m.market,
            symbol: m.symbol,
            trade_date: m.price_date,
            close: m.price,
            source: m.market === 'TWSE' ? ('twse' as const) : ('tpex' as const),
          },
        ]
      : prices;
    const v = valueHoldings(
      [{ market: r.market, symbol: r.symbol, quantity: r.quantity }],
      selected,
      asOf,
    )[0]!;
    const cost = stockUnits(r.cost, 2),
      amount = v.market_amount ?? stockFixed(cost, 2),
      delta = stockUnits(amount, 2) - cost;
    const age = v.price_date
      ? marketAge(v.price_date, taipeiToday(now), calendar, false)
      : null;
    return {
      ...r,
      origin: holdingOrigin(origins.filter((t) => t.security_id === r.id)),
      cost: stockFixed(cost, 2),
      average_cost:
        r.quantity === '0'
          ? '0.0000'
          : stockFixed(stockDivide(cost * 100n, BigInt(r.quantity)), 4),
      market_amount: amount,
      unrealized_gain: stockFixed(delta, 2),
      return_percent:
        cost === 0n ? null : stockFixed(stockDivide(delta * 1000000n, cost), 4),
      price: v.price,
      price_date: v.price_date,
      price_source: v.price_date
        ? m
          ? 'manual'
          : r.market === 'TWSE'
            ? 'twse'
            : 'tpex'
        : null,
      missing: v.price === null,
      stale: age?.stale ?? false,
      estimated_days: age?.estimated ?? false,
    };
  });
}
export type StockHolding = Awaited<
  ReturnType<typeof readStockPositions>
>[number];
export function securityReports(db: Database) {
  return {
    async holdings(owner: string, ledger: string, raw: unknown = {}) {
      const q = valid(holdingsQuerySchema, raw),
        asOf = q.as_of ?? taipeiToday();
      return db.begin(async (sql) => {
        const l = await ownedLedger(sql, owner, valid(idSchema, ledger));
        requireStockLedger(l);
        const items = await readStockPositions(sql, l.id, asOf);
        const sum = (
          k: 'cost' | 'market_amount' | 'unrealized_gain' | 'realized_gain',
        ) =>
          stockFixed(
            items.reduce((a, r) => a + stockUnits(r[k], 2), 0n),
            2,
          );
        return {
          report: 'holdings' as const,
          ledger_id: l.id,
          base_currency: l.base_currency,
          as_of: asOf,
          items,
          totals: {
            cost: sum('cost'),
            market_amount: sum('market_amount'),
            unrealized_gain: sum('unrealized_gain'),
            realized_gain: sum('realized_gain'),
          },
        };
      });
    },
    async realized(owner: string, ledger: string, raw: unknown = {}) {
      const q = valid(realizedQuerySchema, raw);
      return db.begin(async (sql) => {
        const l = await ownedLedger(sql, owner, valid(idSchema, ledger));
        requireStockLedger(l);
        if (q.security_id) await readSecurity(sql, l.id, q.security_id);
        const items = await sql<
          {
            security_id: string;
            name: string;
            symbol: string;
            market: string;
            origin: 'app' | 'emoney';
            booked: boolean;
            booked_total: string;
            unbooked_total: string;
            trade_count: number;
            gross: string;
            cost_removed: string;
            fees: string;
            realized_gain: string;
          }[]
        >`SELECT s.id security_id,s.name,s.symbol,s.market,coalesce(t.origin,'app') origin,(t.transaction_id IS NOT NULL) booked,round(coalesce(sum(t.realized_gain) FILTER(WHERE t.transaction_id IS NOT NULL),0),2)::text booked_total,round(coalesce(sum(t.realized_gain) FILTER(WHERE t.transaction_id IS NULL),0),2)::text unbooked_total,count(t.id)::int trade_count,coalesce(sum(t.gross) FILTER(WHERE t.trade_type='sell'),0)::text gross,coalesce(sum(t.cost_removed),0)::text cost_removed,coalesce(sum(t.fee+t.tax) FILTER(WHERE t.trade_type='sell'),0)::text fees,coalesce(sum(t.realized_gain),0)::text realized_gain FROM securities s LEFT JOIN security_trades t ON t.security_id=s.id AND t.ledger_id=s.ledger_id AND (${q.date_from ?? null}::date IS NULL OR t.trade_date>=${q.date_from ?? null}) AND (${q.date_to ?? null}::date IS NULL OR t.trade_date<=${q.date_to ?? null}) WHERE s.ledger_id=${l.id} AND (${q.security_id ?? null}::uuid IS NULL OR s.id=${q.security_id ?? null}) GROUP BY s.id,t.origin,(t.transaction_id IS NOT NULL) ORDER BY s.market,s.symbol,origin,booked DESC`;
        return {
          report: 'realized-gains' as const,
          ledger_id: l.id,
          base_currency: l.base_currency,
          ...q,
          items,
          booked_total: stockFixed(
            items.reduce((a, r) => a + stockUnits(r.booked_total, 2), 0n),
            2,
          ),
          unbooked_total: stockFixed(
            items.reduce((a, r) => a + stockUnits(r.unbooked_total, 2), 0n),
            2,
          ),
          total: stockFixed(
            items.reduce((a, r) => a + stockUnits(r.realized_gain, 2), 0n),
            2,
          ),
        };
      });
    },
    async history(
      owner: string,
      ledger: string,
      security: string,
      raw: unknown = {},
    ) {
      const q = valid(stockHistoryQuerySchema, raw);
      let cursor: { date: string; sequence: number } | null = null;
      if (q.cursor) {
        try {
          const c = JSON.parse(
            Buffer.from(q.cursor, 'base64url').toString(),
          ) as { date: string; sequence: number; security: string };
          if (
            c.security !== security ||
            !dateSchema.safeParse(c.date).success ||
            !Number.isSafeInteger(c.sequence) ||
            c.sequence < 1
          )
            throw new Error();
          cursor = c;
        } catch {
          throw new DomainError('invalid_input', 400);
        }
      }
      return db.begin(async (sql) => {
        const l = await ownedLedger(sql, owner, valid(idSchema, ledger));
        requireStockLedger(l);
        await readSecurity(sql, l.id, valid(idSchema, security));
        const rows =
          await sql`SELECT t.*,t.trade_date::text,t.quantity::text,t.quantity_after::text,t.price::text,t.fee::text,t.tax::text,t.cost_after::text,t.cash_amount::text,t.gross::text,t.cost_removed::text,t.position_quantity::text,t.position_cost::text,t.realized_gain::text FROM security_trades t WHERE t.ledger_id=${l.id} AND t.security_id=${security} AND (${cursor?.date ?? null}::date IS NULL OR (t.trade_date,t.sequence)<(${cursor?.date ?? null}::date,${cursor?.sequence ?? null}::int)) ORDER BY t.trade_date DESC,t.sequence DESC LIMIT ${q.limit + 1}`;
        const items = rows.slice(0, q.limit),
          last = items.at(-1);
        return {
          items,
          next_cursor:
            rows.length > q.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    date: last.trade_date,
                    sequence: last.sequence,
                    security,
                  }),
                ).toString('base64url')
              : null,
        };
      });
    },
    async trade(
      owner: string,
      ledger: string,
      security: string,
      trade: string,
    ) {
      return db.begin(async (sql) => {
        const l = await ownedLedger(sql, owner, valid(idSchema, ledger));
        requireStockLedger(l);
        await readSecurity(sql, l.id, security);
        const [r] =
          await sql`SELECT t.*,t.trade_date::text,t.quantity::text,t.quantity_after::text,t.price::text,t.fee::text,t.tax::text,t.cost_after::text,t.cash_amount::text FROM security_trades t WHERE t.ledger_id=${l.id} AND t.security_id=${security} AND t.id=${valid(idSchema, trade)}`;
        if (!r) throw new DomainError('not_found', 404);
        return r;
      });
    },
    async prices(owner: string, ledger: string) {
      return db.begin(async (sql) => {
        const l = await ownedLedger(sql, owner, valid(idSchema, ledger));
        requireStockLedger(l);
        return sql`SELECT m.*,m.price_date::text,m.price::text FROM manual_prices m WHERE m.ledger_id=${l.id} ORDER BY m.price_date DESC,m.market,m.symbol`;
      });
    },
  };
}
