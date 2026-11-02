// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
export const kindSchema = z.enum([
  'asset',
  'liability',
  'income',
  'expense',
  'equity',
]);
const designation = z
  .object({ kind: kindSchema, non_operating: z.boolean().default(false) })
  .strict();
export const mappingSchema = z
  .object({
    item_classes: z.record(z.string(), designation).default({}),
    items: z
      .array(
        designation
          .extend({ item_class: z.string(), item_note: z.string() })
          .strict(),
      )
      .default([]),
    item_currencies: z
      .array(
        z
          .object({
            item_class: z.string().min(1),
            item_note: z.string().min(1),
            currency: z.string().regex(/^[A-Z]{3}$/),
          })
          .strict(),
      )
      .default([])
      .refine(
        (rows) =>
          new Set(rows.map((r) => JSON.stringify([r.item_class, r.item_note])))
            .size === rows.length,
        'duplicate_item_currency_mapping',
      ),
    exclude_opening: z.array(z.string()).default([]),
    opening_rates: z
      .record(
        z.string(),
        z
          .string()
          .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,10})?$/)
          .refine((s) => /[1-9]/.test(s)),
      )
      .default({}),
    currencies: z
      .record(z.string(), z.string().regex(/^[A-Z]{3}$/))
      .default({}),
  })
  .strict();
export type Mapping = z.infer<typeof mappingSchema>;
export const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
  );
export const numericSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/);
export const rateSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,10})?$/)
  .refine((s) => /[1-9]/.test(s));
export const itemSchema = z
  .object({
    key: z.string(),
    name: z.string().min(1),
    kind: kindSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    parent_key: z.string().nullable(),
    non_operating: z.boolean(),
    fixed: z.boolean(),
    credit_card: z.boolean(),
    loan: z.boolean(),
    system_created: z.boolean(),
    source_keys: z.array(z.string()),
  })
  .strict();
export const entrySchema = z
  .object({
    item_key: z.string(),
    amount: numericSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    exchange_rate: rateSchema,
    base_amount: numericSchema,
    source_keys: z.array(z.string()),
  })
  .strict();
export const transactionSchema = z
  .object({
    source_key: z.string(),
    occurred_on: dateSchema,
    memo: z.string(),
    kind: z.enum(['income', 'expense', 'transfer', 'adjustment']),
    project_key: z.string().nullable(),
    payee_key: z.string().nullable(),
    entries: z.array(entrySchema).min(2),
  })
  .strict();
export const issueSchema = z
  .object({
    code: z.string(),
    table: z.string(),
    row: z.number().int(),
    key: z.string(),
    difference: numericSchema.optional(),
    count: z.number().int().positive().optional(),
  })
  .strict();
export const reportSchema = z
  .object({
    opening_ignored_totals: z.record(z.string(), numericSchema),
    opening_balances: z.array(
      z
        .object({
          item_key: z.string(),
          name: z.string(),
          kind: kindSchema,
          currency: z.string(),
          amount: numericSchema,
          base_amount: numericSchema.nullable(),
          occurred_on: dateSchema,
          warnings: z.array(z.string()),
          excluded: z.boolean(),
        })
        .strict(),
    ),
    warnings: z.array(z.string()),
    warning_counts: z
      .record(z.string(), z.number().int().nonnegative())
      .default({}),
    warning_details: z.array(issueSchema).default([]),
    errors: z.array(issueSchema),
    skipped: z.array(issueSchema),
    unknown_item_classes: z.record(z.string(), z.number().int()),
    unknown_currencies: z.record(z.string(), z.number().int()),
    missing_projects: z.record(z.string(), z.number().int()),
    kind_natural_totals: z.record(z.string(), numericSchema),
    fx_rounding_count: z.number().int(),
    fx_rounding_total: numericSchema,
    unbalanced_total: numericSchema,
    single_leg_adjustment_count: z.number().int(),
    currency_leg_counts: z.record(z.string(), z.number().int()),
    parsed_only_counts: z.record(z.string(), z.number().int()),
  })
  .strict();
export const planSchema = z
  .object({
    format: z.literal('finmichi-emoney'),
    schemaVersion: z.literal(1),
    source_sha256: shaSchema,
    source_date: dateSchema,
    exported_at: z.string().datetime(),
    mapping_sha256: shaSchema.nullable(),
    items: z.array(itemSchema),
    projects: z.array(
      z.object({ key: z.string(), name: z.string().min(1) }).strict(),
    ),
    payees: z.array(
      z.object({ key: z.string(), name: z.string().min(1) }).strict(),
    ),
    rates: z.array(
      z
        .object({
          key: z.string(),
          rate_date: dateSchema,
          from_currency: z.string().regex(/^[A-Z]{3}$/),
          to_currency: z.literal('TWD'),
          rate: rateSchema,
          as_of_source: z.boolean(),
        })
        .strict(),
    ),
    transactions: z.array(transactionSchema),
    staging: z.record(z.string(), z.array(z.record(z.string(), z.string()))),
    report: reportSchema,
  })
  .strict();
export type Plan = z.infer<typeof planSchema>;
export type Item = Plan['items'][number];
export type Row = Record<string, string>;
export class ImportError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: unknown = null,
  ) {
    super(code);
  }
}
