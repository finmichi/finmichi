// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { Database } from '@finmichi/db';
import { formatMoney, moneyUnits, sumMoney } from '@finmichi/core';
import {
  ImportError,
  numericSchema,
  kindSchema,
  reportSchema,
  type Plan,
} from './schema.js';
import { owner } from './import.js';
const balanceSchema = z
  .object({
    kind: kindSchema,
    name: z.string(),
    currency: z.string(),
    amount: numericSchema,
    base_amount: numericSchema,
    natural_amount: numericSchema,
  })
  .strict();
export const reconciliationSchema = z
  .object({
    transaction_count: z.number().int().nonnegative(),
    skipped_counts: z.record(z.string(), z.number().int()),
    error_counts: z.record(z.string(), z.number().int()),
    fx_rounding_count: z.number().int(),
    fx_rounding_total: numericSchema,
    opening_balance_count: z.number().int(),
    balances: z.array(balanceSchema),
    total_assets: numericSchema,
    total_liabilities: numericSchema,
    net_worth: numericSchema,
  })
  .strict();
export type Reconciliation = z.infer<typeof reconciliationSchema>;
const countCodes = (rows: { code: string }[]) =>
  Object.fromEntries(
    [...new Set(rows.map((r) => r.code))]
      .sort()
      .map((code) => [code, rows.filter((r) => r.code === code).length]),
  );
function finish(
  balances: Reconciliation['balances'],
  count: number,
  report: Plan['report'],
): Reconciliation {
  balances = balances.map((b) => ({
    ...b,
    amount: formatMoney(moneyUnits(b.amount)),
    base_amount: formatMoney(moneyUnits(b.base_amount)),
    natural_amount: formatMoney(moneyUnits(b.natural_amount)),
  }));
  balances.sort((a, b) =>
    [a.kind, a.name, a.currency]
      .join('\0')
      .localeCompare([b.kind, b.name, b.currency].join('\0'), 'en'),
  );
  const total_assets = sumMoney(
      balances.filter((i) => i.kind === 'asset').map((i) => i.base_amount),
    ),
    total_liabilities = formatMoney(
      -moneyUnits(
        sumMoney(
          balances
            .filter((i) => i.kind === 'liability')
            .map((i) => i.base_amount),
        ),
      ),
    );
  return {
    transaction_count: count,
    skipped_counts: countCodes(report.skipped),
    error_counts: countCodes(report.errors),
    fx_rounding_count: report.fx_rounding_count,
    fx_rounding_total: report.fx_rounding_total,
    opening_balance_count: report.opening_balances.filter(
      (r) =>
        !r.excluded &&
        ['asset', 'liability'].includes(r.kind) &&
        r.base_amount !== null,
    ).length,
    balances,
    total_assets,
    total_liabilities,
    net_worth: formatMoney(
      moneyUnits(total_assets) - moneyUnits(total_liabilities),
    ),
  };
}
export function reconcilePlan(plan: Plan): Reconciliation {
  const balances = plan.items.map((item) => {
    const entries = plan.transactions.flatMap((t) =>
        t.entries.filter((e) => e.item_key === item.key),
      ),
      amount = sumMoney(entries.map((e) => e.amount)),
      base_amount = sumMoney(entries.map((e) => e.base_amount));
    return {
      kind: item.kind,
      name: item.name,
      currency: item.currency,
      amount,
      base_amount,
      natural_amount: ['liability', 'income', 'equity'].includes(item.kind)
        ? formatMoney(-moneyUnits(base_amount))
        : base_amount,
    };
  });
  return finish(balances, plan.transactions.length, plan.report);
}
export async function reconcileDatabase(
  db: Database,
  subject: string,
  name: string,
): Promise<Reconciliation> {
  const actor = await owner(db, subject);
  return (await db.begin('ISOLATION LEVEL REPEATABLE READ', async (sql) => {
    const [ledger] =
      await sql`SELECT id FROM ledgers WHERE owner_id=${actor} AND lower(name)=lower(${name})`;
    if (!ledger) throw new ImportError('not_found');
    const id = String(ledger.id),
      jobs =
        await sql`SELECT report FROM import_jobs WHERE ledger_id=${id} AND source_system='emoney-mdb' AND kind='ledger' AND status='imported'`;
    if (jobs.length !== 1) throw new ImportError('emoney_job_not_unique');
    const report = reportSchema.strip().parse(jobs[0]!.report);
    const balances =
      await sql`SELECT i.kind,i.name,i.currency,coalesce(sum(e.amount),0)::text AS amount,coalesce(sum(e.base_amount),0)::text AS base_amount,((CASE WHEN i.kind IN ('liability','income','equity') THEN -1 ELSE 1 END)*coalesce(sum(e.base_amount),0))::text AS natural_amount FROM items i LEFT JOIN transaction_entries e ON e.item_id=i.id AND e.ledger_id=i.ledger_id WHERE i.ledger_id=${id} GROUP BY i.id`;
    const [count] =
      await sql`SELECT count(*)::int AS count FROM transactions WHERE ledger_id=${id}`;
    return finish(
      balances.map((r) => balanceSchema.parse(r)),
      Number(count!.count),
      report,
    );
  })) as Reconciliation;
}
export const baselineSchema = reconciliationSchema.partial();
export function compareBaseline(actual: Reconciliation, input: unknown) {
  const baseline = baselineSchema.parse(input),
    differences: { path: string; expected: unknown; actual: unknown }[] = [];
  function compare(a: unknown, b: unknown, path: string) {
    if (
      typeof a === 'string' &&
      typeof b === 'string' &&
      numericSchema.safeParse(a).success &&
      numericSchema.safeParse(b).success
    ) {
      if (moneyUnits(a) !== moneyUnits(b))
        differences.push({ path, expected: b, actual: a });
      return;
    }
    if (Array.isArray(b)) {
      const as = Array.isArray(a) ? a : [];
      if (path === 'balances') {
        const key = (r: unknown) => {
          const x = balanceSchema.parse(r);
          return JSON.stringify([x.kind, x.name, x.currency]);
        };
        const am = new Map(as.map((x) => [key(x), x])),
          bm = new Map(b.map((x) => [key(x), x]));
        if (am.size !== as.length || bm.size !== b.length)
          throw new ImportError('duplicate_baseline_balance');
        for (const k of new Set([...am.keys(), ...bm.keys()]))
          compare(am.get(k), bm.get(k), path + '.' + k);
      } else {
        for (let i = 0; i < Math.max(as.length, b.length); i++)
          compare(as[i], b[i], `${path}[${i}]`);
      }
      return;
    }
    if (
      b !== null &&
      typeof b === 'object' &&
      a !== null &&
      typeof a === 'object'
    ) {
      for (const k of path === 'skipped_counts' || path === 'error_counts'
        ? new Set([...Object.keys(a), ...Object.keys(b)])
        : Object.keys(b))
        compare(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          path ? path + '.' + k : k,
        );
      return;
    }
    if (a !== b) differences.push({ path, expected: b, actual: a });
  }
  for (const key of Object.keys(baseline))
    compare(
      actual[key as keyof Reconciliation],
      baseline[key as keyof Reconciliation],
      key,
    );
  return { matches: differences.length === 0, differences };
}
