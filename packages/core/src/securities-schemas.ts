// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { dateSchema } from './transaction-schemas.js';
import { idSchema, nameSchema } from './catalog-schemas.js';
export const stockCurrencyMessage = '股票功能目前僅支援本位幣為新臺幣的帳本';
export const stockMoney = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/);
export const stockPrice = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/);
export const stockQuantity = z.string().regex(/^[1-9]\d{0,13}$/);
const quantityAfter = z.string().regex(/^(?:0|[1-9]\d{0,13})$/);
export const securitySchema = z.strictObject({
  symbol: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{4,6}$/),
  name: nameSchema,
  market: z.enum(['TWSE', 'TPEx']),
  kind: z.enum(['stock', 'etf']),
  item_id: idSchema,
  archived: z.boolean().default(false),
});
export const securityUpdateSchema = securitySchema
  .omit({ archived: true })
  .partial()
  .extend({ archived: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0);
const common = {
  trade_date: dateSchema,
  sequence: z.number().int().min(1).max(2147483646).optional(),
  note: z.string().max(2000).default(''),
  settlement_item_id: idSchema.nullable().default(null),
  expense_item_id: idSchema.nullable().default(null),
  gain_item_id: idSchema.nullable().default(null),
};
const dealing = {
  quantity: stockQuantity,
  price: stockPrice,
  fee: stockMoney.default('0'),
  tax: stockMoney.default('0'),
};
export const stockTradeSchema = z.discriminatedUnion('trade_type', [
  z.strictObject({ ...common, trade_type: z.literal('buy'), ...dealing }),
  z.strictObject({ ...common, trade_type: z.literal('sell'), ...dealing }),
  z.strictObject({
    ...common,
    trade_type: z.literal('stock_dividend'),
    quantity: stockQuantity,
  }),
  z
    .strictObject({
      ...common,
      trade_type: z.literal('adjust'),
      quantity_after: quantityAfter,
      cost_mode: z.enum(['keep', 'set_cost', 'cash_return']),
      cost_after: stockMoney.optional(),
      cash_amount: stockMoney.optional(),
    })
    .superRefine((v, ctx) => {
      if (
        v.cost_mode === 'set_cost'
          ? v.cost_after === undefined || v.cash_amount !== undefined
          : v.cost_mode === 'cash_return'
            ? v.cash_amount === undefined ||
              !/[1-9]/.test(v.cash_amount) ||
              v.cost_after !== undefined
            : v.cost_after !== undefined || v.cash_amount !== undefined
      )
        ctx.addIssue({ code: 'custom', message: 'invalid adjust fields' });
    }),
]);
export type StockTradeInput = z.infer<typeof stockTradeSchema>;
export type Security = z.infer<typeof securitySchema> & {
  id: string;
  ledger_id: string;
};
export const stockPreviewSchema = z
  .strictObject({
    operation: z.enum(['create', 'update', 'delete']),
    trade_id: idSchema.optional(),
    trade: stockTradeSchema.optional(),
  })
  .refine((v) =>
    v.operation === 'create'
      ? !v.trade_id && !!v.trade
      : !!v.trade_id && (v.operation === 'delete' ? !v.trade : !!v.trade),
  );
export const stockWriteSchema = z.strictObject({
  trade: stockTradeSchema,
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm_recalculation: z.boolean().default(false),
});
export const stockDeleteSchema = stockWriteSchema.omit({ trade: true });
export const holdingsQuerySchema = z.strictObject({
  as_of: dateSchema.optional(),
});
export const realizedQuerySchema = z
  .strictObject({
    date_from: dateSchema.optional(),
    date_to: dateSchema.optional(),
    security_id: idSchema.optional(),
  })
  .refine((v) => !v.date_from || !v.date_to || v.date_from <= v.date_to);
export const manualPriceSchema = z.strictObject({
  market: z.enum(['TWSE', 'TPEx']),
  symbol: securitySchema.shape.symbol,
  price_date: dateSchema,
  price: stockPrice,
});
export const stockHistoryQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^[1-9]\d?$/)
    .transform(Number)
    .default(50),
  cursor: z.string().max(2048).optional(),
});
