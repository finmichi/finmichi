// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { dateSchema } from './transaction-schemas.js';
export const balanceReportSchema = z.strictObject({ as_of: dateSchema });
export interface ReportMeta {
  report: string;
  ledger_id: string;
  base_currency: string;
  generated_at: string;
}
export interface BalanceValuation {
  own_market_amount: string;
  market_amount: string;
  unrealized_amount: string;
  rate: string | null;
  rate_date: string | null;
  source: 'book' | 'bot' | 'bot-cross' | 'missing' | 'manual' | 'market';
  stock_quotes?: import('./securities-read.js').StockHolding[];
  missing: boolean;
  stale: boolean;
  estimated_days: boolean;
}
export interface BalanceMarket {
  assets: string;
  liabilities: string;
  net_worth: string;
  unrealized_amount: string;
  runs: import('./market-schemas.js').MarketRun[];
  stock_notice: string;
}
export interface BalanceItem {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'asset' | 'liability' | 'equity';
  currency: string;
  archived: boolean;
  credit_card: boolean;
  loan: boolean;
  valuation?: BalanceValuation;
  own_book_amount: string;
  book_amount: string;
  own_original_amount: string;
  original_balances: {
    currency: string;
    original_amount: string;
    book_amount: string;
  }[];
}
export interface BalanceReport extends ReportMeta {
  report: 'balance-sheet';
  market?: BalanceMarket;
  as_of: string;
  totals: {
    assets: string;
    liabilities: string;
    net_worth: string;
    equity: string;
    net_income: string;
    identity_difference: string;
    is_balanced: boolean;
  };
  items: BalanceItem[];
}

export const incomeReportSchema = z
  .strictObject({
    date_from: dateSchema,
    date_to: dateSchema,
    grain: z.enum(['day', 'month', 'quarter', 'year']),
    project_id: z.uuid().optional(),
  })
  .refine((q) => q.date_from <= q.date_to);
export interface IncomeValues {
  operating_income: string;
  non_operating_income: string;
  operating_expense: string;
  non_operating_expense: string;
  income_total: string;
  expense_total: string;
  net_income: string;
}
export interface IncomeReport extends ReportMeta {
  report: 'income-summary';
  date_from: string;
  date_to: string;
  grain: 'day' | 'month' | 'quarter' | 'year';
  periods: (IncomeValues & {
    bucket_start: string;
    date_from: string;
    date_to: string;
    label: string;
  })[];
  totals: IncomeValues;
}

export const categoryReportSchema = z
  .strictObject({
    date_from: dateSchema,
    date_to: dateSchema,
    kind: z.enum(['income', 'expense']),
    project_id: z.uuid().optional(),
    non_operating: z.enum(['all', 'operating', 'non_operating']).default('all'),
    fixed: z.enum(['all', 'fixed', 'variable']).default('all'),
  })
  .refine((q) => q.date_from <= q.date_to);
export interface CategoryItem {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'income' | 'expense';
  non_operating: boolean;
  fixed: boolean;
  archived: boolean;
  is_leaf: boolean;
  own_amount: string;
  rollup_amount: string;
  percentage: string | null;
}
export interface CategoryReport extends ReportMeta {
  report: 'category-statistics';
  date_from: string;
  date_to: string;
  kind: 'income' | 'expense';
  non_operating: 'all' | 'operating' | 'non_operating';
  fixed: 'all' | 'fixed' | 'variable';
  total_amount: string;
  root_amount: string;
  root_count: string;
  root_total_matches: boolean;
  root_percentage_sum: string | null;
  percentage_tolerance: string;
  percentage_sum_within_tolerance: boolean | null;
  pie_available: boolean;
  pie_reason: 'negative_total' | 'zero_total' | 'negative_items' | null;
  items: CategoryItem[];
  pie: CategoryItem[];
  bars: (CategoryItem & { chart_weight: string })[];
}

export const budgetReportSchema = z.strictObject({
  year: z.coerce.number().int().min(1).max(9999),
  grain: z.enum(['month', 'quarter', 'year']),
  kind: z.enum(['income', 'expense']),
  non_operating: z.enum(['all', 'operating', 'non_operating']).default('all'),
  fixed: z.enum(['all', 'fixed', 'variable']).default('all'),
});
export interface BudgetTotals {
  budget_total: string;
  actual_total: string;
  variance: string;
  achievement: string | null;
}
export interface BudgetItem {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'income' | 'expense';
  non_operating: boolean;
  fixed: boolean;
  archived: boolean;
  budget_own: string;
  budget_rollup: string;
  actual_rollup: string;
  variance: string;
  achievement: string | null;
}
export interface BudgetReport extends ReportMeta {
  report: 'budget-vs-actual';
  year: number;
  grain: 'month' | 'quarter' | 'year';
  kind: 'income' | 'expense';
  non_operating: 'all' | 'operating' | 'non_operating';
  fixed: 'all' | 'fixed' | 'variable';
  totals: BudgetTotals;
  periods: (BudgetTotals & {
    bucket_start: string;
    label: string;
    items: BudgetItem[];
  })[];
}

// ADR-0011: the same strict contracts are consumed by REST and MCP.
export const reportDateSchema = dateSchema.refine(
  (value) => !value.startsWith('0000-'),
);
const reportDates = { date_from: reportDateSchema, date_to: reportDateSchema };
const orderedDates = (q: { date_from: string; date_to: string }) =>
  q.date_from <= q.date_to;
export const profitLossSchema = z
  .strictObject({
    ...reportDates,
    grain: z.enum(['month', 'quarter', 'year']),
  })
  .refine(orderedDates)
  .refine((q) => {
    const year = Number(q.date_from.slice(0, 4)) + 10;
    if (year > 9999) return true;
    const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
    const suffix =
      q.date_from.slice(4) === '-02-29' && !leap
        ? '-02-28'
        : q.date_from.slice(4);
    return q.date_to < String(year).padStart(4, '0') + suffix;
  });
export const netWorthFlowSchema = z
  .strictObject({
    ...reportDates,
    grain: z.enum(['day', 'month', 'quarter', 'year']),
  })
  .refine(orderedDates);
export const accountLedgerSchema = z
  .strictObject({
    ...reportDates,
    item_id: z.uuid(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().max(4096).optional(),
  })
  .refine(orderedDates);
export interface ProfitValues extends IncomeValues {
  bucket_start: string | null;
  label: string;
  operating_profit: string;
  non_operating_profit: string;
  fixed_expense: string;
  variable_expense: string;
  operating_margin: string | null;
}
export interface ProfitItem {
  id: string;
  parent_id: string | null;
  name: string;
  amounts: string[];
  total: string;
}
export interface ProfitLossReport extends ReportMeta {
  report: 'profit-loss';
  date_from: string;
  date_to: string;
  grain: 'month' | 'quarter' | 'year';
  periods: ProfitValues[];
  totals: ProfitValues;
  sections: {
    key:
      | 'operating_income'
      | 'operating_expense'
      | 'non_operating_income'
      | 'non_operating_expense';
    items: ProfitItem[];
  }[];
}
export interface FlowPeriod {
  bucket_start: string;
  label: string;
  date_from: string;
  date_to: string;
  opening: string;
  income: string;
  expense: string;
  equity_change: string;
  closing: string;
  is_balanced: boolean;
  identity_difference: string;
}
export interface NetWorthFlowReport extends ReportMeta {
  report: 'net-worth-flow';
  date_from: string;
  date_to: string;
  grain: 'day' | 'month' | 'quarter' | 'year';
  periods: FlowPeriod[];
}
export interface AccountLedgerEntry {
  entry_id: string;
  transaction_id: string;
  entry_position: number;
  created_at: string;
  occurred_on: string;
  memo: string;
  item_id: string;
  item_name: string;
  counterpart: string;
  currency: string;
  amount: string;
  exchange_rate: string;
  base_amount: string;
  inflow: string;
  outflow: string;
  original_balance: string;
  book_balance: string;
}
export interface AccountLedgerReport extends ReportMeta {
  report: 'account-ledger';
  item_id: string;
  date_from: string;
  date_to: string;
  balances: {
    currency: string;
    opening_original: string;
    opening_book: string;
    closing_original: string;
    closing_book: string;
  }[];
  carry: { currency: string; original_balance: string; book_balance: string }[];
  items: AccountLedgerEntry[];
  next_cursor: string | null;
}

export const projectReportSchema = z
  .strictObject({
    date_from: reportDateSchema,
    date_to: reportDateSchema,
    include_archived: z.enum(['true', 'false']).default('false'),
  })
  .refine(orderedDates);
export interface ProjectReportItem {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'income' | 'expense';
  own_amount: string;
  rollup_amount: string;
}
export interface ProjectReportRow {
  id: string;
  name: string;
  archived: boolean;
  income: string;
  expense: string;
  net: string;
  transaction_count: number;
  first_on: string | null;
  last_on: string | null;
  days: number;
  daily_average_expense: string | null;
  items: ProjectReportItem[];
  currencies: {
    currency: string;
    original_expense: string;
    base_expense: string;
  }[];
  months: { month: string; income: string; expense: string; net: string }[];
}
export interface ProjectReport extends ReportMeta {
  report: 'projects';
  date_from: string;
  date_to: string;
  include_archived: boolean;
  projects: ProjectReportRow[];
}
