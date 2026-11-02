// SPDX-License-Identifier: AGPL-3.0-only
import { projectReportSchema, type ProjectReport } from './report-schemas.js';
import type { Transaction } from '@finmichi/db';
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
async function projectRef(
  sql: Transaction,
  ledger: string,
  project: string | undefined,
) {
  if (
    project &&
    !(
      await sql`SELECT id FROM projects WHERE ledger_id=${ledger} AND id=${project}`
    ).length
  )
    throw new DomainError('not_found', 404);
}
export function reportService(db: Database) {
  return {
    ...extendedReportService(db),
    async projects(
      actor: string,
      ledger: string,
      input: unknown,
    ): Promise<ProjectReport> {
      valid(idSchema, actor);
      valid(idSchema, ledger);
      return await db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger, false);
        const q = valid(projectReportSchema, input);
        const [r] = await sql<
          { report: ProjectReport | null }[]
        >`SELECT report_projects(${actor},${ledger},${q.date_from}::text::date,${q.date_to}::text::date,${q.include_archived === 'true'}) report`;
        if (!r?.report) throw new DomainError('not_found', 404);
        // Date navigation metadata is independent of the report period. The
        // existing SQL report and all its period-scoped amounts stay unchanged.
        const [ledgerDates] = await sql<{ first_on: string | null }[]>`
          SELECT min(occurred_on)::text first_on FROM transactions WHERE ledger_id=${ledger}`;
        const projectDates = await sql<
          {
            project_id: string;
            first_on: string;
            last_on: string;
          }[]
        >`SELECT project_id,min(occurred_on)::text first_on,max(occurred_on)::text last_on
          FROM transactions WHERE ledger_id=${ledger} AND project_id IS NOT NULL GROUP BY project_id`;
        const dates = new Map(projectDates.map((d) => [d.project_id, d]));
        return {
          ...r.report,
          first_transaction_on: ledgerDates?.first_on ?? null,
          projects: r.report.projects.map((p) => ({
            ...p,
            available_first_on: dates.get(p.id)?.first_on ?? null,
            available_last_on: dates.get(p.id)?.last_on ?? null,
          })),
        };
      });
    },
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
        await projectRef(sql, ledger, q.project_id);
        const [row] = await sql<
          { report: CategoryReport | null }[]
        >`${q.project_id ? sql`SELECT report_category_statistics_project(${actor},${ledger},${q.date_from}::text::date,${q.date_to}::text::date,${q.kind},${q.non_operating},${q.fixed},${q.project_id}) AS report` : sql`SELECT report_category_statistics(${actor},${ledger},${q.date_from}::text::date,${q.date_to}::text::date,${q.kind},${q.non_operating},${q.fixed}) AS report`}`;
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
          await projectRef(sql, ledger, q.project_id);
          const [row] = await sql<
            { report: IncomeReport | null }[]
          >`${q.project_id ? sql`SELECT report_income_summary_project(${actor},${ledger},${q.date_from}::text::date,${q.date_to}::text::date,${q.grain},${q.project_id}) AS report` : sql`SELECT report_income_summary(${actor},${ledger},${q.date_from}::text::date,${q.date_to}::text::date,${q.grain}) AS report`}`;
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
