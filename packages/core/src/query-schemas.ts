// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema, type Item } from './catalog-schemas.js';
import { dateSchema, type TransactionRecord } from './transaction-schemas.js';
export const transactionKindSchema = z.enum([
  'income',
  'expense',
  'transfer',
  'adjustment',
]);
const amount = z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/);
const fields = {
  date_from: dateSchema.optional(),
  date_to: dateSchema.optional(),
  item_id: idSchema.optional(),
  project_id: idSchema.optional(),
  payee_id: idSchema.optional(),
  keyword: z.string().trim().max(200).optional(),
  amount_min: amount.optional(),
  amount_max: amount.optional(),
  kind: transactionKindSchema.optional(),
};
function cents(v: string) {
  const [a, b = ''] = v.split('.');
  return BigInt(a!) * 100n + BigInt(b.padEnd(2, '0'));
}
function ranges(v: {
  date_from?: string | undefined;
  date_to?: string | undefined;
  amount_min?: string | undefined;
  amount_max?: string | undefined;
}) {
  return (
    (!v.date_from || !v.date_to || v.date_from <= v.date_to) &&
    (!v.amount_min ||
      !v.amount_max ||
      cents(v.amount_min) <= cents(v.amount_max))
  );
}
export const filterSchema = z.strictObject(fields).refine(ranges);
export const querySchema = z
  .strictObject({
    ...fields,
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .refine((v) => v <= 100)
      .default(25),
    cursor: z.string().max(2048).optional(),
  })
  .refine(ranges);
export const summarySchema = z
  .strictObject({ ...fields, group_by: z.enum(['item', 'month', 'project']) })
  .refine(ranges);
export type QueryFilter = z.infer<typeof filterSchema>;
export type QueryInput = z.infer<typeof querySchema>;
export interface QueryEntry {
  item_id: string;
  item_name: string;
  item_kind: Item['kind'];
  amount: string;
  currency: string;
  exchange_rate: string;
  base_amount: string;
  entry_position: number;
}
export interface QueryRow {
  dividend_id?: string | null;
  deposit_id?: string | null;
  security_trade_id?: string | null;
  security_id?: string | null;
  id: string;
  ledger_id: string;
  occurred_on: string;
  created_at: string;
  kind: TransactionRecord['kind'];
  memo: string;
  invoice_no: string;
  payee_id: string | null;
  payee_name: string | null;
  project_id: string | null;
  project_name: string | null;
  transaction_amount: string;
  selected_net_amount: string | null;
  entries: QueryEntry[];
}
export interface QueryTotals {
  count: number;
  by_kind: {
    kind: TransactionRecord['kind'];
    count: number;
    transaction_amount: string;
  }[];
  selected_net_amount: string | null;
}
export interface QueryPage {
  items: QueryRow[];
  next_cursor: string | null;
  totals: QueryTotals;
}
export interface ItemSummary {
  id: string;
  parent_id: string | null;
  name: string;
  kind: Item['kind'];
  entry_count: number;
  signed_amount: string;
  natural_amount: string;
  rollup_signed_amount: string;
  rollup_natural_amount: string;
}
export interface MonthSummary {
  month: string;
  kind: TransactionRecord['kind'];
  count: number;
  transaction_amount: string;
  selected_net_amount: string | null;
}
export interface QuerySummary {
  group_by: 'item' | 'month' | 'project';
  projects?: {
    id: string;
    name: string;
    count: number;
    transaction_amount: string;
    selected_net_amount: string | null;
  }[];
  items: ItemSummary[];
  months: MonthSummary[];
  monthly_net: { month: string; selected_net_amount: string }[];
  totals: QueryTotals;
}
