// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile, rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { connect, migrate, operationalErrorCode } from '@finmichi/db';
import {
  runRecurringWorker,
  workerRetryDelay,
  runMarketWorker,
} from '@finmichi/core';
async function main() {
  let stage: 'config_invalid' | 'migration_pending' | 'worker_failed' =
    'config_invalid';
  let db: ReturnType<typeof connect> | undefined;
  try {
    const databaseUrl = process.env.DATABASE_URL_FILE
      ? (await readFile(process.env.DATABASE_URL_FILE, 'utf8')).trim()
      : process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL required');
    db = connect(databaseUrl);
    const stop = new AbortController();
    process.on('SIGTERM', () => stop.abort());
    process.on('SIGINT', () => stop.abort());
    let beating = false;
    async function heartbeat() {
      if (beating) return;
      beating = true;
      try {
        await writeFile(
          '/tmp/worker-health.tmp',
          JSON.stringify({ at: Date.now() }),
        );
        await rename('/tmp/worker-health.tmp', '/tmp/worker-health.json');
      } finally {
        beating = false;
      }
    }
    const timer = setInterval(() => {
      void heartbeat().catch(() => {
        console.error(
          JSON.stringify({
            event: 'recurring.worker.health',
            outcome: 'error',
          }),
        );
        stop.abort();
      });
    }, 30000);
    try {
      stage = 'migration_pending';
      await migrate(db);
      stage = 'worker_failed';
      await heartbeat();
      let failures = 0;
      do {
        let delay = 30000;
        try {
          const result = await runRecurringWorker(db);
          if (process.env.MARKET_DATA_ENABLED === 'true' && !process.env.CI) {
            const market = await runMarketWorker(
              db,
              new Date(),
              undefined,
              (event) => {
                console.log(JSON.stringify(event));
              },
            );
            console.log(JSON.stringify({ event: 'market.worker', ...market }));
          }
          failures = 0;
          console.log(JSON.stringify({ event: 'recurring.worker', ...result }));
        } catch (error) {
          failures++;
          delay = workerRetryDelay(failures, 30000, 1800000);
          console.error(
            JSON.stringify({
              event: 'recurring.worker',
              outcome: 'error',
              code: operationalErrorCode(error, 'worker_failed'),
              retry_in_ms: delay,
            }),
          );
        }
        if (process.argv.includes('--once')) break;
        try {
          await setTimeout(delay, undefined, { signal: stop.signal });
        } catch {
          if (!stop.signal.aborted) throw new Error('Worker wait failed');
        }
      } while (!stop.signal.aborted);
    } finally {
      clearInterval(timer);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'recurring.worker.start',
        outcome: 'error',
        code: operationalErrorCode(error, stage),
      }),
    );
    process.exitCode = 1;
  } finally {
    await db?.end();
  }
}
void main();
