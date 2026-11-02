// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction } from '@finmichi/db';
import { valid, DomainError } from './catalog.js';
import { idSchema } from './catalog-schemas.js';

import {
  reportDateSchema,
  profitLossSchema,
  netWorthFlowSchema,
  accountLedgerSchema,
  type ProfitLossReport,
  type NetWorthFlowReport,
  type AccountLedgerReport,
} from './report-schemas.js';
const cursorSchema = z.strictObject({
  scope: z.string(),
  occurred_on: reportDateSchema,
  created_at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}(?::\d{2})?$/,
    )
    .refine((value) => reportDateSchema.safeParse(value.slice(0, 10)).success),
  transaction_id: z.uuid(),
  entry_position: z.number().int().min(0).max(2147483647),
  entry_id: z.uuid(),
});

async function ownedReport(sql: Transaction, actor: string, ledger: string) {
  valid(idSchema, actor);
  valid(idSchema, ledger);
  const [row] =
    await sql`SELECT id FROM ledgers WHERE owner_id=${actor} AND id=${ledger}`;
  if (!row) throw new DomainError('not_found', 404);
}
async function account(
  sql: Transaction,
  actor: string,
  ledger: string,
  input: unknown,
): Promise<AccountLedgerReport> {
  const q = valid(accountLedgerSchema, input);
  const scope = createHash('sha256')
    .update(JSON.stringify([actor, ledger, q.item_id, q.date_from, q.date_to]))
    .digest('hex');
  let after: z.infer<typeof cursorSchema> | null = null;
  if (q.cursor) {
    try {
      after = valid(
        cursorSchema,
        JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')),
      );
      if (
        !Number.isFinite(Date.parse(after.created_at)) ||
        after.scope !== scope
      )
        throw new Error();
    } catch {
      throw new DomainError('invalid_input', 400);
    }
  }
  const [r] = await sql<
    { report: (AccountLedgerReport & { has_more: boolean }) | null }[]
  >`SELECT report_account_ledger(${actor},${ledger},${q.item_id},${q.date_from}::date,${q.date_to}::date,${q.limit},${after === null ? null : sql.json(after)}) report`;
  if (!r?.report) throw new DomainError('not_found', 404);
  const { has_more, ...report } = r.report,
    last = report.items.at(-1);
  return {
    ...report,
    next_cursor:
      has_more && last
        ? Buffer.from(
            JSON.stringify({
              scope,
              occurred_on: last.occurred_on,
              created_at: last.created_at,
              transaction_id: last.transaction_id,
              entry_position: last.entry_position,
              entry_id: last.entry_id,
            }),
          ).toString('base64url')
        : null,
  };
}
export function extendedReportService(db: Database) {
  async function read<T>(
    actor: string,
    ledger: string,
    fn: (sql: Transaction) => Promise<T>,
  ): Promise<T> {
    try {
      return (await db.begin(async (sql) => {
        await ownedReport(sql, actor, ledger);
        return fn(sql);
      })) as T;
    } catch (e) {
      if (
        e &&
        typeof e === 'object' &&
        'code' in e &&
        e.code === 'P0001' &&
        'message' in e &&
        ['invalid_input', 'period_range_too_large'].includes(String(e.message))
      )
        throw new DomainError(String(e.message), 400);
      throw e;
    }
  }
  return {
    profitLoss(
      actor: string,
      ledger: string,
      input: unknown,
    ): Promise<ProfitLossReport> {
      return read(actor, ledger, async (sql) => {
        const q = valid(profitLossSchema, input);
        const [r] = await sql<
          { report: ProfitLossReport | null }[]
        >`SELECT report_profit_loss(${actor},${ledger},${q.date_from}::date,${q.date_to}::date,${q.grain}) report`;
        if (!r?.report) throw new DomainError('not_found', 404);
        return r.report;
      });
    },
    netWorthFlow(
      actor: string,
      ledger: string,
      input: unknown,
    ): Promise<NetWorthFlowReport> {
      return read(actor, ledger, async (sql) => {
        const q = valid(netWorthFlowSchema, input);
        const [r] = await sql<
          { report: NetWorthFlowReport | null }[]
        >`SELECT report_net_worth_flow(${actor},${ledger},${q.date_from}::date,${q.date_to}::date,${q.grain}) report`;
        if (!r?.report) throw new DomainError('not_found', 404);
        return r.report;
      });
    },
    accountLedger(
      actor: string,
      ledger: string,
      input: unknown,
    ): Promise<AccountLedgerReport> {
      return read(actor, ledger, (sql) => account(sql, actor, ledger, input));
    },
    async accountLedgerAll(
      actor: string,
      ledger: string,
      input: unknown,
    ): Promise<AccountLedgerReport> {
      return (await db.begin(
        'isolation level repeatable read read only',
        async (sql) => {
          await ownedReport(sql, actor, ledger);
          const q = valid(
            z.strictObject({
              date_from: reportDateSchema,
              date_to: reportDateSchema,
              item_id: idSchema,
            }),
            input,
          );
          let page = await account(sql, actor, ledger, { ...q, limit: 500 });
          const result = { ...page, items: [...page.items] };
          while (page.next_cursor) {
            page = await account(sql, actor, ledger, {
              ...q,
              limit: 500,
              cursor: page.next_cursor,
            });
            result.items.push(...page.items);
          }
          return { ...result, carry: page.carry, next_cursor: null };
        },
      )) as AccountLedgerReport;
    },
  };
}
