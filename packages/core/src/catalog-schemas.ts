// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
export const idSchema = z.uuid();
export const nameSchema = z.string().trim().min(1).max(200);
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const ledgerCreateSchema = z.strictObject({
  name: nameSchema,
  base_currency: currencySchema.default('TWD'),
});
export const ledgerUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    base_currency: currencySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0);
export interface Ledger {
  id: string;
  name: string;
  base_currency: string;
  locked_until: string | null;
}

export const itemKindSchema = z.enum([
  'asset',
  'liability',
  'income',
  'expense',
  'equity',
]);
const itemMutable = z.strictObject({
  name: nameSchema,
  parent_id: idSchema.nullable(),
  non_operating: z.boolean(),
  fixed: z.boolean(),
  credit_card: z.boolean(),
  loan: z.boolean(),
  securities: z.boolean(),
  archived: z.boolean(),
});
export const itemCreateSchema = itemMutable.extend({
  kind: itemKindSchema,
  currency: currencySchema,
  parent_id: idSchema.nullable().default(null),
  non_operating: z.boolean().default(false),
  fixed: z.boolean().default(false),
  credit_card: z.boolean().default(false),
  loan: z.boolean().default(false),
  securities: z.boolean().default(false),
  archived: z.boolean().default(false),
});
export const itemUpdateSchema = itemMutable
  .partial()
  .refine((v) => Object.keys(v).length > 0);
export const catalogQuerySchema = z.strictObject({
  include_archived: z.enum(['true', 'false']).default('false'),
});
export type Item = Omit<z.infer<typeof itemCreateSchema>, 'securities'> & {
  securities?: boolean;
  id: string;
  ledger_id: string;
};

export const namedCreateSchema = z.strictObject({
  name: nameSchema,
  archived: z.boolean().default(false),
});
export const namedUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0);
export interface NamedRecord {
  memo?: string;
  id: string;
  ledger_id: string;
  name: string;
  archived: boolean;
}

export const memoSchema = z.string().trim().min(1).max(2000);
export const memoCreateSchema = namedCreateSchema.extend({ memo: memoSchema });
export const memoUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    archived: z.boolean().optional(),
    memo: memoSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0);
