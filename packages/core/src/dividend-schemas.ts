// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema, nameSchema } from './catalog-schemas.js';
import { dateSchema } from './transaction-schemas.js';
import { stockMoney } from './securities-schemas.js';
export const incomeCodeDisclaimer = '代碼與名稱以集保結算所／發行機構通知為準';
export const incomeCodeSchema = z.strictObject({
  code: z.string().trim().min(1).max(100),
  label: nameSchema,
  income_item_id: idSchema.nullable().default(null),
});
export const dividendComponentSchema = z.strictObject({
  code: incomeCodeSchema.shape.code,
  label: nameSchema,
  amount: stockMoney,
  taxable: z.boolean(),
});
export const dividendSchema = z
  .strictObject({
    security_id: idSchema,
    ex_date: dateSchema,
    pay_date: dateSchema,
    per_share: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/),
    shares: z.string().regex(/^(?:0|[1-9]\d{0,13})$/),
    gross_amount: stockMoney,
    withholding_tax: stockMoney.default('0'),
    nhi_premium: stockMoney.default('0'),
    fee: stockMoney.default('0'),
    net_amount: stockMoney,
    stock_shares: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,13})$/)
      .default('0'),
    source_document: z
      .strictObject({
        filename: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[^/\\]+$/)
          .refine((v) =>
            Array.from(v).every(
              (c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127,
            ),
          ),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        page: z.number().int().min(1).max(100000),
      })
      .nullable()
      .default(null),
    note: z.string().max(2000).default(''),
    settlement_item_id: idSchema.nullable().default(null),
    default_income_item_id: idSchema.nullable().default(null),
    tax_item_id: idSchema.nullable().default(null),
    expense_item_id: idSchema.nullable().default(null),
    components: z.array(dividendComponentSchema).max(100),
  })
  .refine((d) => d.ex_date <= d.pay_date);
export type DividendInput = z.infer<typeof dividendSchema>;
export const dividendPreviewSchema = z
  .strictObject({
    operation: z.enum(['create', 'update', 'delete']),
    id: idSchema.optional(),
    dividend: dividendSchema.optional(),
  })
  .refine((v) =>
    v.operation === 'create'
      ? !v.id && !!v.dividend
      : !!v.id && (v.operation === 'delete' ? !v.dividend : !!v.dividend),
  );
export const dividendWriteSchema = z.strictObject({
  dividend: dividendSchema,
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm_recalculation: z.boolean().default(false),
});
export const dividendDeleteSchema = dividendWriteSchema.omit({
  dividend: true,
});
export const dividendReportSchema = z
  .strictObject({
    date_from: dateSchema.optional(),
    date_to: dateSchema.optional(),
    security_id: idSchema.optional(),
  })
  .refine((q) => !q.date_from || !q.date_to || q.date_from <= q.date_to);
