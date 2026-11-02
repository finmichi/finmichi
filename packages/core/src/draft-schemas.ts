// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema } from './catalog-schemas.js';
import {
  transactionCreateSchema,
  type TransactionInput,
  type Preview,
} from './transaction-schemas.js';
export const draftStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
]);
export const DEFAULT_DRAFT_LIMIT = '100000';
export const draftLimitSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
  .refine((v) => {
    if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(v)) return false;
    const [a, b = ''] = v.split('.');
    const cents = BigInt(a!) * 100n + BigInt(b.padEnd(2, '0'));
    return cents >= 1n && cents <= 1000000000n;
  });
export const draftCreateSchema = transactionCreateSchema.safeExtend({
  ledger_id: idSchema,
  note: z.string().max(500).default(''),
});
export const draftApproveSchema = z.strictObject({
  payload: transactionCreateSchema.optional(),
});
export const draftQuerySchema = z.strictObject({
  status: draftStatusSchema.optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d?$/)
    .transform(Number)
    .refine((n) => n <= 50)
    .default(25),
  cursor: z.string().max(2048).optional(),
});
export interface TransactionDraft {
  id: string;
  ledger_id: string;
  token_prefix: string | null;
  payload: TransactionInput;
  preview: Preview;
  note: string;
  status: z.infer<typeof draftStatusSchema>;
  created_at: string;
  decided_at: string | null;
  transaction_id: string | null;
}
export interface DraftPage {
  items: TransactionDraft[];
  next_cursor: string | null;
  pending_count: number;
  max_base_amount: string;
}
