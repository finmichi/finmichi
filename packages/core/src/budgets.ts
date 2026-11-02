// SPDX-License-Identifier: AGPL-3.0-only
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, mutation, ownedLedger, valid } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import {
  budgetQuerySchema,
  budgetSaveSchema,
  budgetDistributeSchema,
  budgetTargetSchema,
  distributeAnnualBudget,
  type Budget,
} from './budget-schemas.js';
async function item(sql: Transaction, ledger: string, id: string) {
  const [i] =
    await sql`SELECT kind FROM items WHERE id=${id} AND ledger_id=${ledger} FOR UPDATE`;
  if (!i) throw new DomainError('not_found', 404);
  if (!['income', 'expense'].includes(i.kind))
    throw new DomainError('budget_item_kind_invalid', 400);
}
export function budgetService(db: Database) {
  async function save(
    actor: string,
    ledgerId: unknown,
    input: unknown,
    annual = false,
  ) {
    return mutation(db, actor, 'budget.update', async (sql) => {
      const ledger = valid(idSchema, ledgerId);
      await ownedLedger(sql, actor, ledger);
      const q = annual
        ? valid(budgetDistributeSchema, input)
        : valid(budgetSaveSchema, input);
      await item(sql, ledger, q.item_id);
      const months =
        'total' in q
          ? distributeAnnualBudget(q.total).map((amount, i) => ({
              month: i + 1,
              amount,
            }))
          : q.months;
      for (const m of months)
        await sql`INSERT INTO budgets(ledger_id,year,item_id,month,amount) VALUES (${ledger},${q.year},${q.item_id},${m.month},${m.amount}) ON CONFLICT(ledger_id,year,item_id,month) DO UPDATE SET amount=excluded.amount`;
      return sql<
        Budget[]
      >`SELECT id,ledger_id,year,item_id,month,amount::text FROM budgets WHERE ledger_id=${ledger} AND year=${q.year} AND item_id=${q.item_id} ORDER BY month`;
    });
  }
  return {
    save: (a: string, l: unknown, i: unknown) => save(a, l, i),
    distribute: (a: string, l: unknown, i: unknown) => save(a, l, i, true),
    async list(actor: string, ledgerId: unknown, input: unknown) {
      const ledger = valid(idSchema, ledgerId);
      return db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger);
        const q = valid(budgetQuerySchema, input);
        return sql<
          Budget[]
        >`SELECT id,ledger_id,year,item_id,month,amount::text FROM budgets WHERE ledger_id=${ledger} AND year=${q.year} ORDER BY item_id,month`;
      });
    },
    async remove(actor: string, ledgerId: unknown, input: unknown) {
      return mutation(db, actor, 'budget.delete', async (sql) => {
        const ledger = valid(idSchema, ledgerId);
        await ownedLedger(sql, actor, ledger);
        const q = valid(budgetTargetSchema, input);
        await item(sql, ledger, q.item_id);
        await sql`DELETE FROM budgets WHERE ledger_id=${ledger} AND year=${q.year} AND item_id=${q.item_id}`;
      });
    },
  };
}
