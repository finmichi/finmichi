// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
export const reminderTypes = [
  'deposit',
  'card',
  'loan',
  'recurring',
  'draft',
  'market',
] as const;
export type ReminderType = (typeof reminderTypes)[number];
const days = (n: number) => z.number().int().min(0).max(60).default(n);
export const reminderSettingsSchema = z.strictObject({
  deposit_enabled: z.boolean().default(true),
  deposit_days: days(7),
  card_enabled: z.boolean().default(true),
  card_days: days(7),
  loan_enabled: z.boolean().default(true),
  loan_days: days(3),
  recurring_enabled: z.boolean().default(true),
  recurring_days: days(0),
  draft_enabled: z.boolean().default(true),
  draft_days: days(0),
  market_enabled: z.boolean().default(true),
  market_trading_days: z.number().int().min(1).max(20).default(3),
});
export type ReminderSettings = z.infer<typeof reminderSettingsSchema>;
export const reminderKeySchema = z
  .string()
  .max(120)
  .regex(
    /^(?:deposit:[0-9a-f-]{36}|card:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}|loan:[0-9a-f-]{36}:\d+|occurrence:[0-9a-f-]{36}|draft:[0-9a-f-]{36}|market:(?:bot|twse|tpex))$/,
  );
export const reminderFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const reminderReadSchema = z.union([
  z.strictObject({
    items: z
      .array(
        z.strictObject({
          key: reminderKeySchema,
          fingerprint: reminderFingerprintSchema,
        }),
      )
      .min(1)
      .max(200),
  }),
  z.strictObject({ all: z.literal(true) }),
]);
export interface Reminder {
  key: string;
  fingerprint: string;
  type: ReminderType;
  date: string;
  overdue_days: number;
  title: string;
  detail: string;
  href: string;
  read: boolean;
}
export interface RemindersResult {
  as_of: string;
  items: Reminder[];
  unread_count: number;
}
