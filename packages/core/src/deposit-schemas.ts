// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema, nameSchema } from './catalog-schemas.js';
import { dateSchema } from './transaction-schemas.js';
export const depositMoney = z
  .string()
  .regex(/^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/);
export const depositSchema = z.strictObject({
  item_id: idSchema,
  bank: nameSchema,
  principal: depositMoney,
  annual_rate: z.string().regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/),
  start_on: dateSchema,
  maturity_on: dateSchema,
  interest_basis: z.enum(['monthly', 'daily']),
  payout: z.enum(['at_maturity', 'monthly']),
  auto_renew: z.boolean().default(false),
  payout_account_id: idSchema,
  interest_item_id: idSchema,
  note: z.string().max(2000).default(''),
});
export type DepositInput = z.infer<typeof depositSchema>;
export const depositAmountSchema = z.strictObject({
  period_no: z.number().int().positive().optional(),
  posted_on: dateSchema,
  gross_interest: depositMoney,
  withholding_tax: depositMoney.default('0'),
  nhi_premium: depositMoney.default('0'),
  renew: z
    .enum(['none', 'principal', 'principal_and_interest'])
    .default('none'),
  tax_item_id: idSchema.nullable().default(null),
  exchange_rate: z
    .string()
    .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,10})?$/)
    .optional(),
});
export type DepositAmounts = z.infer<typeof depositAmountSchema>;
export const depositPreviewSchema = z
  .strictObject({
    operation: z.enum(['interest', 'settlement', 'revoke']),
    posting_id: idSchema.optional(),
    amounts: depositAmountSchema.optional(),
  })
  .refine((v) =>
    v.operation === 'revoke'
      ? !!v.posting_id && !v.amounts
      : !!v.amounts && !v.posting_id,
  );
export const depositWriteSchema = depositAmountSchema.extend({
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const depositRevokeSchema = z.strictObject({
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const depositReportSchema = z.strictObject({
  as_of: dateSchema.optional(),
});
export interface DepositPosting {
  id: string;
  ledger_id: string;
  deposit_id: string;
  kind: 'interest' | 'settlement';
  period_no: number | null;
  posted_on: string;
  gross_interest: string;
  withholding_tax: string;
  nhi_premium: string;
  renew: 'none' | 'principal' | 'principal_and_interest';
  renewed_deposit_id: string | null;
  transaction_id: string | null;
}
export type DepositRecord = DepositInput & {
  id: string;
  ledger_id: string;
  status: 'active' | 'matured' | 'closed';
  renewed_from_id: string | null;
};
