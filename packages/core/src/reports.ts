// SPDX-License-Identifier: AGPL-3.0-only
import { revalueBalance } from './market-valuation.js';
import { cashForecastService } from './cash-forecast.js';
import { extendedReportService } from './report-extensions.js';
import { budgetReportSchema, type BudgetReport } from './report-schemas.js';
import { categoryReportSchema, type CategoryReport } from './report-schemas.js';
import type { Database } from '@finmichi/db';
import { ownedLedger, valid, DomainError } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import { incomeReportSchema, type IncomeReport } from './report-schemas.js';
import { balanceReportSchema, type BalanceReport } from './report-schemas.js';
export function reportService(db: Database) {
  return {
    ...extendedReportService(db),
    cashForecast: cashForecastService(db).forecast,
    async budget(
      actor: string,
      ledger: string,
      input: unknown,
    ): Promise<BudgetReport> {
      valid(idSchema, actor);
      valid(idSchema, ledger);
      return await db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger);
        const q = valid(budgetReportSchema, input);
        const [r] = await sql<
          { report: BudgetReport | null }[]
        >`SELECT report_budget_vs_actual(${actor},${ledger},${q.year},${q.grain},${q.kind},${q.non_operating},${q.fixed}) report`;
        if (!r?.report) throw new DomainError('not_found', 404);
        return r.report;
      });
    },
    async category(
      actor: string,
      ledger: string,
      input: unknown,
    ): Promise<CategoryReport> {
      valid(idSchema, actor);
      valid(idSchema, ledger);
      return (await db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger);
        const q = valid(categoryReportSchema, input);
        const [row] = await sql<
          { report: CategoryReport | null }[]
        >`SELECT report_category_statistics(${actor},${ledger},${q.date_from}::text::date,${q.date_to}::text::date,${q.kind},${q.non_operating},${q.fixed}) AS report`;
        if (!row?.report) throw new DomainError('not_found', 404);
        return row.report;
      })) as CategoryReport;
    },
    async income(
      actor: string,
      ledger: string,
      input: unknown,
    ): Promise<IncomeReport> {
      valid(idSchema, actor);
      valid(idSchema, ledger);
      try {
        return (await db.begin(async (sql) => {
          await ownedLedger(sql, actor, ledger);
          const q = valid(incomeReportSchema, input);
          const [row] = await sql<
            { report: IncomeReport | null }[]
          >`SELECT report_income_summary(${actor},${ledger},${q.date_from}::text::date,${q.date_to}::text::date,${q.grain}) AS report`;
          if (!row?.report) throw new DomainError('not_found', 404);
          return row.report;
        })) as IncomeReport;
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'P0001' &&
          'message' in error &&
          error.message === 'period_range_too_large'
        )
          throw new DomainError('period_range_too_large', 400);
        throw error;
      }
    },
    async balance(
      actor: string,
      ledger: string,
      input: unknown,
    ): Promise<BalanceReport> {
      valid(idSchema, actor);
      valid(idSchema, ledger);
      return (await db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger);
        const q = valid(balanceReportSchema, input);
        const [row] = await sql<
          { report: BalanceReport | null }[]
        >`SELECT report_balance_sheet(${actor},${ledger},${q.as_of}::text::date) AS report`;
        if (!row?.report) throw new DomainError('not_found', 404);
        return revalueBalance(sql, row.report);
      })) as BalanceReport;
    },
  };
}
