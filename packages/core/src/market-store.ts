// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { Database, Transaction } from '@finmichi/db';
import { ownedLedger, mutation, valid, DomainError } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import { marketAge } from './market-math.js';
import { taipeiToday } from './ledger-lock.js';
import {
  fxUploadSchema,
  MarketDataError,
  type FxRate,
  type MarketRun,
  type MarketDashboard,
  type MarketPriceCoverage,
  type FxUploadPreview,
  type MarketBatch,
} from './market-schemas.js';
import { botFilenameDate, parseBot } from './market-parse.js';
export async function readMarketFx(
  sql: Transaction,
  asOf: string,
): Promise<FxRate[]> {
  return sql<
    FxRate[]
  >`SELECT rate_date::text,currency,source,spot_buy::text,spot_sell::text,cash_buy::text,cash_sell::text,method FROM market_fx_rates WHERE rate_date<=${asOf} ORDER BY rate_date DESC,currency`;
}
export async function readMarketRuns(
  sql: Transaction,
  now = new Date(),
): Promise<MarketRun[]> {
  const rows = await sql<
    Omit<MarketRun, 'stale' | 'estimated_days'>[]
  >`SELECT source,status,method,data_date::text,received_date::text,error_code,to_char(last_finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') last_finished_at,to_char(next_retry_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') next_retry_at,skipped_no_price,skipped_no_rate FROM market_fetch_runs ORDER BY source`;
  const dates = rows
    .filter((r) => r.source !== 'calendar' && r.data_date)
    .map((r) => r.data_date!)
    .sort();
  const calendar = dates.length
    ? await sql<
        import('./market-schemas.js').MarketDay[]
      >`SELECT date::text,market,is_trading_day,source FROM market_calendar WHERE date>${dates[0]!} AND date<${taipeiToday(now)}`
    : [];
  return rows.map((r) => {
    const age =
      r.source !== 'calendar' && r.data_date
        ? marketAge(r.data_date, taipeiToday(now), calendar, r.source === 'bot')
        : null;
    return {
      ...r,
      stale: age?.stale ?? false,
      estimated_days: age?.estimated ?? false,
    };
  });
}
export async function applyMarketBatch(
  sql: Transaction,
  b: MarketBatch,
  now: Date,
  method: 'fetch' | 'upload' = 'fetch',
) {
  await sql`INSERT INTO market_fetch_runs(source) VALUES (${b.source}) ON CONFLICT DO NOTHING`;
  await sql`SELECT source FROM market_fetch_runs WHERE source=${b.source} FOR UPDATE`;
  const [latest] =
    b.source === 'bot'
      ? await sql`SELECT max(rate_date)::text AS latest_date FROM market_fx_rates WHERE source='bot'`
      : b.source === 'twse' || b.source === 'tpex'
        ? await sql`SELECT max(trade_date)::text AS latest_date FROM market_prices WHERE source=${b.source}`
        : [{ latest_date: null }];
  const old = !!(
    b.data_date &&
    latest?.latest_date &&
    b.data_date < String(latest.latest_date)
  );
  let accepted = 0;
  if (!old) {
    const fx = b.fx.map((r) => ({
      ...r,
      method,
      fetched_at: now.toISOString(),
    }));
    if (fx.length) {
      await sql`INSERT INTO market_fx_rates ${sql(fx, 'rate_date', 'currency', 'source', 'spot_buy', 'spot_sell', 'cash_buy', 'cash_sell', 'method', 'fetched_at')} ON CONFLICT (rate_date,currency,source) DO UPDATE SET spot_buy=EXCLUDED.spot_buy,spot_sell=EXCLUDED.spot_sell,cash_buy=EXCLUDED.cash_buy,cash_sell=EXCLUDED.cash_sell,method=EXCLUDED.method,fetched_at=EXCLUDED.fetched_at`;
      accepted += fx.length;
    }
    const prices = b.prices.map((r) => ({
      ...r,
      fetched_at: now.toISOString(),
    }));
    for (let i = 0; i < prices.length; i += 500) {
      const part = prices.slice(i, i + 500);
      await sql`INSERT INTO market_prices ${sql(part, 'trade_date', 'market', 'symbol', 'close', 'source', 'fetched_at')} ON CONFLICT (trade_date,market,symbol,source) DO UPDATE SET close=EXCLUDED.close,fetched_at=EXCLUDED.fetched_at`;
      accepted += part.length;
    }
  }
  // Calendar entries describe whole years; a later fetch may revise a holiday in an earlier year.
  const days = b.calendar.map((d) => ({ ...d, fetched_at: now.toISOString() }));
  for (let i = 0; i < days.length; i += 500) {
    const part = days.slice(i, i + 500);
    await sql`INSERT INTO market_calendar ${sql(part, 'date', 'market', 'is_trading_day', 'source', 'fetched_at')} ON CONFLICT (date,market) DO UPDATE SET is_trading_day=EXCLUDED.is_trading_day,source=EXCLUDED.source,fetched_at=EXCLUDED.fetched_at`;
    accepted += part.length;
  }
  const status = old
    ? 'no_new_data'
    : b.warning
      ? 'warning'
      : accepted
        ? 'success'
        : 'no_new_data';
  const code = b.warning
    ? b.source === 'calendar'
      ? 'calendar_partial'
      : 'many_missing_prices'
    : null;
  await sql`UPDATE market_fetch_runs SET status=${status},method=${method},last_finished_at=${now.toISOString()},data_date=GREATEST(data_date,${b.data_date}::date),received_date=${b.data_date},error_code=${code},row_count=${b.row_count},skipped_no_price=${b.skipped_no_price},skipped_no_rate=${b.skipped_no_rate},failure_count=0,next_retry_at=NULL,source_filename=${b.filename ?? null},first_success_filename=COALESCE(first_success_filename,${method === 'fetch' && b.source === 'bot' ? (b.filename ?? null) : null}) WHERE source=${b.source}`;
  return {
    accepted,
    status,
    data_date: b.data_date,
    skipped_no_price: b.skipped_no_price,
    skipped_no_rate: b.skipped_no_rate,
  };
}
function uploadPreview(input: unknown): {
  data: ReturnType<typeof fxUploadSchema.parse>;
  batch: MarketBatch;
  preview: FxUploadPreview;
} {
  const data = valid(fxUploadSchema, input);
  try {
    const batch = parseBot(data.content, data.filename, data.rate_date);
    return {
      data,
      batch,
      preview: {
        data_date: batch.data_date!,
        row_count: batch.row_count,
        accepted: batch.fx.length,
        skipped_no_rate: batch.skipped_no_rate,
        rates: batch.fx,
        date_source: botFilenameDate(data.filename) ? 'filename' : 'user',
      },
    };
  } catch (e) {
    if (e instanceof MarketDataError) throw new DomainError(e.code, 400);
    throw e;
  }
}
export function marketService(db: Database) {
  return {
    async dashboard(
      actor: string,
      ledger: string,
      input: unknown = {},
    ): Promise<MarketDashboard> {
      valid(idSchema, actor);
      valid(idSchema, ledger);
      return db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger, false);
        valid(z.strictObject({}), input);
        const rates = await sql<
          FxRate[]
        >`SELECT DISTINCT ON(currency) rate_date::text,currency,source,spot_buy::text,spot_sell::text,cash_buy::text,cash_sell::text,method FROM market_fx_rates WHERE rate_date<=${taipeiToday()} ORDER BY currency,rate_date DESC`;
        const coverage = await sql<MarketPriceCoverage[]>`
          WITH sources(source,market) AS (VALUES ('twse','TWSE'),('tpex','TPEx')),
          latest AS (
            SELECT source,max(source_day)::text data_date FROM (
              SELECT source,data_date AS source_day FROM market_fetch_runs WHERE data_date<=${taipeiToday()}::date
              UNION ALL SELECT source,trade_date FROM market_prices WHERE trade_date<=${taipeiToday()}::date
            ) dates GROUP BY source
          )
          SELECT src.source,l.data_date,
            count(s.id)::int tracked_securities,
            count(s.id) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM market_prices p WHERE p.source=src.source AND p.market=src.market
                AND p.symbol=s.symbol AND p.trade_date=l.data_date::date
            ))::int missing_prices
          FROM sources src LEFT JOIN latest l ON l.source=src.source
          LEFT JOIN securities s ON s.market=src.market AND s.ledger_id=${ledger} AND NOT s.archived
          GROUP BY src.source,l.data_date ORDER BY src.source`;
        return {
          rates,
          runs: await readMarketRuns(sql),
          price_coverage: coverage,
        };
      });
    },
    async previewUpload(actor: string, ledger: string, input: unknown) {
      valid(idSchema, actor);
      valid(idSchema, ledger);
      return db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger, false);
        return uploadPreview(input).preview;
      });
    },
    async upload(
      actor: string,
      ledger: string,
      input: unknown,
      now = new Date(),
    ) {
      valid(idSchema, ledger);
      return mutation(db, actor, 'market.fx_upload', async (sql) => {
        await ownedLedger(sql, actor, ledger);
        const parsed = uploadPreview(input);
        const result = await applyMarketBatch(sql, parsed.batch, now, 'upload');
        // Uploads are not proof that an automatic scheduled fetch succeeded.
        await sql`UPDATE market_fetch_runs SET scheduled_key=NULL WHERE source='bot'`;
        return { ...parsed.preview, ...result, method: 'upload' as const };
      });
    },
  };
}
