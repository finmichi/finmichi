// SPDX-License-Identifier: AGPL-3.0-only
import { depositReportSchema } from './deposit-schemas.js';
import { dividendReportSchema } from './dividend-schemas.js';
import {
  holdingsQuerySchema,
  realizedQuerySchema,
} from './securities-schemas.js';
import { draftCreateSchema, draftStatusSchema } from './draft-schemas.js';
import { cashForecastSchema } from './cash-forecast-schemas.js';
import { z } from 'zod';
import { idSchema } from './catalog-schemas.js';
import { filterSchema } from './query-schemas.js';
import {
  profitLossSchema,
  netWorthFlowSchema,
  accountLedgerSchema,
  balanceReportSchema,
  budgetReportSchema,
  incomeReportSchema,
  categoryReportSchema,
} from './report-schemas.js';
export const mcpTools = [
  'list_ledgers',
  'list_items',
  'search_transactions',
  'get_balance',
  'get_report',
] as const;
export const mcpDraftTools = [
  'draft_transaction',
  'suggest_item',
  'list_drafts',
] as const;
export const allMcpTools = [...mcpTools, ...mcpDraftTools] as const;
export type McpTool = (typeof allMcpTools)[number];
export const mcpSchemas = {
  draft_transaction: draftCreateSchema,
  suggest_item: z.strictObject({
    ledger_id: idSchema,
    text: z.string().trim().min(1).max(2000),
  }),
  list_drafts: z.strictObject({
    status: draftStatusSchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().max(2048).optional(),
  }),
  list_ledgers: z.strictObject({}),
  list_items: z.strictObject({
    ledger_id: idSchema,
    include_archived: z.boolean().optional(),
  }),
  search_transactions: filterSchema.safeExtend({
    ledger_id: idSchema,
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(2048).optional(),
  }),
  get_balance: balanceReportSchema.safeExtend({
    ledger_id: idSchema,
    item_id: idSchema.optional(),
  }),
  get_report: z.discriminatedUnion('report', [
    z.strictObject({ ledger_id: idSchema, report: z.literal('reminders') }),
    depositReportSchema.extend({
      ledger_id: idSchema,
      report: z.literal('deposits'),
    }),
    dividendReportSchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('dividends'),
    }),
    holdingsQuerySchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('holdings'),
    }),
    realizedQuerySchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('realized-gains'),
    }),
    cashForecastSchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('cash-forecast'),
    }),
    profitLossSchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('profit-loss'),
    }),
    netWorthFlowSchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('net-worth-flow'),
    }),
    accountLedgerSchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('account-ledger'),
    }),
    budgetReportSchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('budget-vs-actual'),
    }),
    balanceReportSchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('balance-sheet'),
    }),
    incomeReportSchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('income-summary'),
    }),
    categoryReportSchema.safeExtend({
      ledger_id: idSchema,
      report: z.literal('category-statistics'),
    }),
  ]),
};
