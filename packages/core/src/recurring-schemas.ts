// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema, nameSchema } from './catalog-schemas.js';
import {
  transactionCreateSchema,
  transactionUpdateSchema,
} from './transaction-schemas.js';
const date = z.iso.date().refine((s) => !s.startsWith('0000'));
export const recurringTemplateSchema = transactionCreateSchema.omit({
  occurred_on: true,
});
export const recurringRuleSchema = z
  .strictObject({
    name: nameSchema,
    template: recurringTemplateSchema,
    frequency: z.enum(['monthly', 'weekly', 'yearly']),
    interval: z.number().int().min(1).max(12).default(1),
    day_of_month: z.number().int().min(1).max(31).nullable().default(null),
    weekday: z.number().int().min(0).max(6).nullable().default(null),
    month: z.number().int().min(1).max(12).nullable().default(null),
    day: z.number().int().min(1).max(31).nullable().default(null),
    start_on: date,
    end_on: date.nullable().default(null),
    active: z.boolean().default(true),
    auto_post: z.boolean().default(false),
  })
  .superRefine((v, c) => {
    if (v.end_on && v.end_on < v.start_on)
      c.addIssue({ code: 'custom', message: 'end before start' });
    if (
      v.frequency === 'monthly'
        ? v.day_of_month === null ||
          v.weekday !== null ||
          v.month !== null ||
          v.day !== null
        : v.frequency === 'weekly'
          ? v.weekday === null ||
            v.day_of_month !== null ||
            v.month !== null ||
            v.day !== null
          : v.month === null ||
            v.day === null ||
            v.day_of_month !== null ||
            v.weekday !== null
    )
      c.addIssue({ code: 'custom', message: 'frequency fields mismatch' });
    if (
      v.frequency === 'yearly' &&
      v.month !== null &&
      v.day !== null &&
      v.day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][v.month - 1]!
    )
      c.addIssue({ code: 'custom', message: 'invalid yearly day' });
  });
export const occurrencePatchSchema = z
  .strictObject({
    occurred_on: transactionUpdateSchema.shape.occurred_on,
    memo: transactionUpdateSchema.shape.memo,
    entries: transactionUpdateSchema.shape.entries,
  })
  .refine((v) => Object.keys(v).length > 0);
export const occurrenceStatusSchema = z.enum([
  'pending',
  'failed',
  'posted',
  'skipped',
]);
export const occurrenceQuerySchema = z.strictObject({
  status: occurrenceStatusSchema.optional(),
});
export const occurrenceIdsSchema = z.strictObject({
  ids: z
    .array(idSchema)
    .min(1)
    .max(100)
    .refine((v) => new Set(v).size === v.length),
});
export type RecurringInput = z.infer<typeof recurringRuleSchema>;
export type RecurringTemplate = z.infer<typeof recurringTemplateSchema>;
export type RecurringRule = RecurringInput & {
  id: string;
  ledger_id: string;
  next_on: string | null;
};
export interface RecurringOccurrence {
  id: string;
  ledger_id: string;
  rule_id: string | null;
  source_rule_id: string;
  rule_name: string;
  occurs_on: string;
  occurred_on: string;
  template: RecurringTemplate;
  status: z.infer<typeof occurrenceStatusSchema>;
  transaction_id: string | null;
  error_code: string | null;
}
export interface RecurringState {
  rules: RecurringRule[];
  pending_count: number;
  worker: {
    last_started_at: string | null;
    last_finished_at: string | null;
    next_retry_at: string | null;
    status: string;
    error_code: string | null;
  } | null;
}
