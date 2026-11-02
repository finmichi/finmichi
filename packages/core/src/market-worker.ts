// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from '@finmichi/db';
import { taipeiToday } from './ledger-lock.js';
import { workerRetryDelay } from './recurring-worker.js';
import { fetchMarket, type MarketFetch } from './market-fetch.js';
import {
  MarketDataError,
  type MarketSource,
  type MarketFetchFailure,
} from './market-schemas.js';
import { applyMarketBatch } from './market-store.js';
import { isWeekday } from './market-math.js';
export function marketSchedule(now: Date) {
  const today = taipeiToday(now),
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Taipei',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  const minute =
    Number(parts.find((p) => p.type === 'hour')!.value) * 60 +
    Number(parts.find((p) => p.type === 'minute')!.value);
  const jobs: { source: MarketSource; key: string }[] = [
    { source: 'calendar', key: today.slice(0, 7) },
  ];
  if (isWeekday(today)) {
    if (minute >= 600)
      jobs.push({
        source: 'bot',
        key: today + (minute >= 990 ? ':1630' : ':1000'),
      });
    if (minute >= 900)
      for (const source of ['twse', 'tpex'] as const)
        jobs.push({ source, key: today });
  }
  return { today, jobs };
}
export async function runMarketWorker(
  db: Database,
  now = new Date(),
  client?: MarketFetch,
  reportFailure?: (event: MarketFetchFailure) => void,
) {
  const { today, jobs } = marketSchedule(now);
  let success = 0,
    errors = 0,
    skipped = 0;
  for (const job of jobs) {
    const claimed = await db.begin(async (sql) => {
      await sql`INSERT INTO market_fetch_runs(source) VALUES (${job.source}) ON CONFLICT DO NOTHING`;
      const [r] =
        await sql`SELECT status,scheduled_key,last_started_at,next_retry_at,blocked_date::text,blocked_attempts FROM market_fetch_runs WHERE source=${job.source} FOR UPDATE`;
      if (
        r!.next_retry_at &&
        new Date(r!.next_retry_at).getTime() > now.getTime()
      )
        return false;
      if (r!.blocked_date === today && Number(r!.blocked_attempts) >= 2)
        return false;
      if (
        r!.status === 'running' &&
        r!.last_started_at &&
        now.getTime() - new Date(r!.last_started_at).getTime() < 300000
      )
        return false;
      if (
        r!.scheduled_key === job.key &&
        !r!.next_retry_at &&
        ['success', 'warning', 'no_new_data', 'skipped_holiday'].includes(
          String(r!.status),
        )
      )
        return false;
      await sql`UPDATE market_fetch_runs SET status='running',method='fetch',scheduled_key=${job.key},last_started_at=${now.toISOString()},last_finished_at=NULL,next_retry_at=NULL,blocked_attempts=CASE WHEN blocked_date=${today}::date THEN blocked_attempts ELSE 0 END,blocked_date=CASE WHEN blocked_date=${today}::date THEN blocked_date ELSE NULL END WHERE source=${job.source}`;
      return true;
    });
    if (!claimed) {
      skipped++;
      continue;
    }
    try {
      if (job.source === 'twse' || job.source === 'tpex') {
        const [holiday] =
          await db`SELECT is_trading_day FROM market_calendar WHERE date=${today} AND market='TWSE'`;
        if (holiday && !holiday.is_trading_day) {
          await db`UPDATE market_fetch_runs SET status='skipped_holiday',last_finished_at=${now.toISOString()},error_code=NULL,failure_count=0,next_retry_at=NULL,row_count=0,skipped_no_price=0,skipped_no_rate=0 WHERE source=${job.source}`;
          skipped++;
          continue;
        }
      }
      const batch = await fetchMarket(job.source, now, client);
      await db.begin(async (sql) => {
        await applyMarketBatch(sql, batch, now);
        // Not-yet-published data is normal. Try later without counting a failure.
        if (
          (job.source === 'twse' || job.source === 'tpex') &&
          (!batch.data_date || batch.data_date < today)
        )
          await sql`UPDATE market_fetch_runs SET next_retry_at=${new Date(now.getTime() + 1800000).toISOString()} WHERE source=${job.source}`;
      });
      success++;
    } catch (error) {
      const code =
        error instanceof MarketDataError ? error.code : 'source_unavailable';
      const detail = await db.begin(async (sql) => {
        const [r] =
          await sql`SELECT failure_count,blocked_date::text,blocked_attempts FROM market_fetch_runs WHERE source=${job.source} FOR UPDATE`;
        if (code === 'blocked_by_source') {
          const attempts = Math.min(
            2,
            (r!.blocked_date === today ? Number(r!.blocked_attempts) : 0) + 1,
          );
          const retry =
            attempts < 2
              ? new Date(now.getTime() + 1800000).toISOString()
              : null;
          await sql`UPDATE market_fetch_runs SET status='blocked_by_source',last_finished_at=${now.toISOString()},error_code='blocked_by_source',blocked_date=${today},blocked_attempts=${attempts},next_retry_at=${retry} WHERE source=${job.source}`;
          return {
            failure_count: Number(r!.failure_count),
            next_retry_at: retry,
          };
        } else {
          const failures = Math.min(1000000, Number(r!.failure_count) + 1),
            retry = new Date(
              now.getTime() + workerRetryDelay(failures),
            ).toISOString();
          await sql`UPDATE market_fetch_runs SET status='error',last_finished_at=${now.toISOString()},error_code=${code},failure_count=${failures},next_retry_at=${retry} WHERE source=${job.source}`;
          return { failure_count: failures, next_retry_at: retry };
        }
      });
      reportFailure?.({
        event: 'market.fetch',
        source: job.source,
        code,
        ...detail,
      });
      errors++;
    }
  }
  return { success, errors, skipped };
}
