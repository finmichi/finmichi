// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema } from './catalog-schemas.js';
export const cashForecastSchema = z.strictObject({
  accounts: z
    .union([z.string().transform((s) => s.split(',')), z.array(idSchema)])
    .pipe(
      z
        .array(idSchema)
        .min(1)
        .max(500)
        .refine((v) => new Set(v).size === v.length),
    )
    .optional(),
  horizon_days: z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(
      z.union([
        z.literal(30),
        z.literal(60),
        z.literal(90),
        z.literal(180),
        z.literal(366),
      ]),
    )
    .default(30),
  threshold: z
    .string()
    .regex(/^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/)
    .default('0'),
});
export interface ForecastAccount {
  id: string;
  name: string;
  opening_balance: string;
}
export interface ForecastEvent {
  date: string;
  source_type:
    'transaction' | 'occurrence' | 'recurring' | 'card' | 'loan' | 'deposit';
  source_id: string;
  memo: string;
  account_id: string;
  amount: string;
}
export interface CashForecastReport {
  warnings: { source_type: 'card'; item_id: string; code: 'fx_rate_missing' }[];
  generated_at: string;
  as_of: string;
  date_to: string;
  base_currency: string;
  horizon_days: number;
  threshold: string;
  accounts: ForecastAccount[];
  opening_total: string;
  days: {
    date: string;
    total: string;
    balances: { account_id: string; balance: string }[];
  }[];
  events: ForecastEvent[];
  first_below_threshold: string | null;
}
