// SPDX-License-Identifier: AGPL-3.0-only
import { expireTransactionDrafts } from './drafts.js';
import type { Database } from '@finmichi/db';
import { recurringService } from './recurring.js';
import { taipeiToday } from './ledger-lock.js';
export function afterWorkerTime(now: Date) {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return Number(h) >= 6;
}
// Scheduling durations only; no financial value passes through Number.
export function workerRetryDelay(
  failures: number,
  base = 300000,
  cap = 21600000,
) {
  return Math.min(cap, base * 2 ** Math.min(20, Math.max(0, failures - 1)));
}
export async function runRecurringWorker(db: Database, now = new Date()) {
  if (!afterWorkerTime(now)) return { success: 0, errors: 0, skipped: 0 };
  await expireTransactionDrafts(db, now);
  const today = taipeiToday(now),
    ledgers = await db<
      { id: string; owner_id: string }[]
    >`SELECT DISTINCT l.id,l.owner_id FROM ledgers l JOIN recurring_rules r ON r.ledger_id=l.id WHERE r.active`;
  let success = 0,
    errors = 0,
    skipped = 0;
  for (const l of ledgers) {
    const claimed = await db.begin(async (sql) => {
      await sql`INSERT INTO recurring_worker_runs(ledger_id,status) VALUES (${l.id},'error') ON CONFLICT DO NOTHING`;
      const [r] =
        await sql`SELECT run_date::text,status,last_started_at,failure_count,next_retry_at FROM recurring_worker_runs WHERE ledger_id=${l.id} FOR UPDATE`;
      if (
        r!.next_retry_at &&
        now.getTime() < new Date(r!.next_retry_at).getTime()
      )
        return false;
      if (
        r!.run_date === today &&
        (r!.status === 'success' ||
          (r!.status === 'running' &&
            r!.last_started_at &&
            now.getTime() - new Date(r!.last_started_at).getTime() < 300000))
      )
        return false;
      await sql`UPDATE recurring_worker_runs SET run_date=${today},last_started_at=${now.toISOString()},last_finished_at=NULL,status='running',error_code=NULL,next_retry_at=NULL WHERE ledger_id=${l.id}`;
      return true;
    });
    if (!claimed) {
      skipped++;
      continue;
    }
    try {
      await recurringService(db).generate(l.owner_id, l.id, now);
      await db`UPDATE recurring_worker_runs SET last_finished_at=${now.toISOString()},status='success',error_code=NULL,failure_count=0,next_retry_at=NULL WHERE ledger_id=${l.id}`;
      success++;
    } catch {
      await db.begin(async (sql) => {
        const [r] =
          await sql`SELECT failure_count FROM recurring_worker_runs WHERE ledger_id=${l.id} FOR UPDATE`;
        const failures = Math.min(1000000, Number(r!.failure_count) + 1);
        const retry = new Date(
          now.getTime() + workerRetryDelay(failures),
        ).toISOString();
        await sql`UPDATE recurring_worker_runs SET last_finished_at=${now.toISOString()},status='error',error_code='worker_failed',failure_count=${failures},next_retry_at=${retry} WHERE ledger_id=${l.id}`;
      });
      errors++;
    }
  }
  return { success, errors, skipped };
}
