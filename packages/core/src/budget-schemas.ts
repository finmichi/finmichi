// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema } from './catalog-schemas.js';
export const budgetAmountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/);
export const budgetYearSchema = z.coerce.number().int().min(1).max(9999);
export const budgetQuerySchema = z.strictObject({ year: budgetYearSchema });
export const budgetTargetSchema = budgetQuerySchema.extend({
  item_id: idSchema,
});
export const budgetSaveSchema = budgetTargetSchema.extend({
  year: z.number().int().min(1).max(9999),
  months: z
    .array(
      z.strictObject({
        month: z.number().int().min(1).max(12),
        amount: budgetAmountSchema,
      }),
    )
    .min(1)
    .max(12)
    .refine((v) => new Set(v.map((x) => x.month)).size === v.length),
});
export const budgetDistributeSchema = budgetTargetSchema.extend({
  year: z.number().int().min(1).max(9999),
  total: budgetAmountSchema,
});
export function distributeAnnualBudget(value: unknown): string[] {
  const amount = budgetAmountSchema.parse(value),
    [whole, part = ''] = amount.split('.');
  const total = BigInt(whole!) * 100n + BigInt(part.padEnd(2, '0')),
    base = total / 12n,
    r = total % 12n;
  return Array.from({ length: 12 }, (_, i) => {
    const n = base + (i === 11 ? r : 0n);
    return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
  });
}
export interface Budget {
  id: string;
  ledger_id: string;
  year: number;
  item_id: string;
  month: number;
  amount: string;
}
