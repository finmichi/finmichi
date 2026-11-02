// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema } from './catalog-schemas.js';
import { dateSchema } from './transaction-schemas.js';
const money = z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/);
export const cardSettingsSchema = z.strictObject({
  item_id: idSchema,
  statement_day: z.number().int().min(1).max(31),
  due_day: z.number().int().min(1).max(31),
  due_month_offset: z.union([z.literal(0), z.literal(1)]),
  payment_account_id: idSchema.nullable(),
  credit_limit: money.nullable(),
});
export const loanSettingsSchema = z.strictObject({
  item_id: idSchema,
  principal: money.refine((v) => /[1-9]/.test(v)),
  annual_rate: z
    .string()
    .regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/)
    .refine((v) => scaled(v, 6) <= 100000000n),
  term_months: z.number().int().min(1).max(600),
  first_payment_on: dateSchema,
  method: z.enum(['annuity', 'equal_principal']),
  payment_account_id: idSchema,
  interest_item_id: idSchema,
});
export type CardSettings = z.infer<typeof cardSettingsSchema>;
export type LoanSettings = z.infer<typeof loanSettingsSchema>;
export function validCardSchedule(
  s: Pick<CardSettings, 'statement_day' | 'due_day' | 'due_month_offset'>,
) {
  return (
    s.due_month_offset === 1 ||
    (s.statement_day <= 27 && s.due_day > s.statement_day)
  );
}
// Exact decimal-string conversion. Caller validates scale before converting.
export function scaled(value: string, digits = 2): bigint {
  const negative = value.startsWith('-');
  const [a, b = ''] = (negative ? value.slice(1) : value).split('.');
  return (
    (negative ? -1n : 1n) *
    (BigInt(a!) * 10n ** BigInt(digits) + BigInt(b.padEnd(digits, '0')))
  );
}
export function centsText(n: bigint): string {
  const sign = n < 0n ? '-' : '';
  const a = n < 0n ? -n : n;
  return sign + String(a / 100n) + '.' + String(a % 100n).padStart(2, '0');
}
