// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema } from './catalog-schemas.js';
export const dateSchema = z.iso.date();
const decimal = z.string().max(40);
export const entrySchema = z.strictObject({
  item_id: idSchema,
  amount: decimal,
  exchange_rate: decimal.optional(),
});
const fields = {
  occurred_on: dateSchema,
  memo: z.string().max(2000),
  payee_id: idSchema.nullable(),
  project_id: idSchema.nullable(),
  invoice_no: z.string().max(100),
  entries: z.array(entrySchema).min(2).max(100),
};
export const transactionCreateSchema = z.strictObject({
  ...fields,
  memo: fields.memo.default(''),
  payee_id: fields.payee_id.default(null),
  project_id: fields.project_id.default(null),
  invoice_no: fields.invoice_no.default(''),
});
export const transactionUpdateSchema = z
  .strictObject(fields)
  .partial()
  .refine((v) => Object.keys(v).length > 0);
export type TransactionInput = z.infer<typeof transactionCreateSchema>;
export interface Entry {
  id: string;
  item_id: string;
  amount: string;
  currency: string;
  exchange_rate: string;
  base_amount: string;
  entry_position: number;
}
export interface TransactionRecord {
  security_trade_id?: string;
  security_id?: string;
  id: string;
  ledger_id: string;
  occurred_on: string;
  memo: string;
  payee_id: string | null;
  project_id: string | null;
  invoice_no: string;
  kind: 'income' | 'expense' | 'transfer' | 'adjustment';
  entries: Entry[];
}
export interface FxComparisonResponse {
  entry_index: number;
  effective_rate: string;
  reference_rate: string | null;
  reference_source:
    'user_input' | 'exchange_rates' | 'bot' | 'bot-cross' | 'none';
  reference_date?: string;
  deviation_percent: string | null;
}
export interface Preview {
  fx_comparisons: FxComparisonResponse[];
  scenario: 'A' | 'C' | 'BD';
  warnings: { code: 'fx_rate_deviation'; entryIndex: number }[];
  entries: {
    item_id: string;
    amount: string;
    currency: string;
    exchange_rate: string;
    base_amount: string;
  }[];
  kind: TransactionRecord['kind'];
}
