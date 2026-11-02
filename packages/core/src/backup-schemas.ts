// SPDX-License-Identifier: AGPL-3.0-only
import {
  reminderSettingsSchema,
  reminderKeySchema,
  reminderFingerprintSchema,
} from './reminder-schemas.js';
import { depositSchema, depositMoney } from './deposit-schemas.js';
import { dividendSchema, incomeCodeSchema } from './dividend-schemas.js';
import { securitySchema, stockPrice } from './securities-schemas.js';
import { cardSettingsSchema, loanSettingsSchema } from './finance-schemas.js';
import { z } from 'zod';
import { idSchema, currencySchema, itemKindSchema } from './catalog-schemas.js';
import {
  recurringRuleSchema,
  recurringTemplateSchema,
  occurrenceStatusSchema,
} from './recurring-schemas.js';
import { dateSchema } from './transaction-schemas.js';
export const BACKUP_MAX_BYTES = 50 * 1024 * 1024;
export const BACKUP_MAX_TRANSACTIONS = 200000;
const timestamp = z.iso.datetime({ offset: true });
const name = z.string().min(1).max(200);
const amount = z.string().regex(/^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/);
const rate = z.string().regex(/^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,10})?$/);
const ref = { id: idSchema, ledger_id: idSchema };
export const backupLedgerSchema = z.strictObject({
  id: idSchema,
  name,
  base_currency: currencySchema,
  locked_until: dateSchema.nullable(),
  created_at: timestamp,
});
export const backupItemSchema = z.strictObject({
  ...ref,
  parent_id: idSchema.nullable(),
  kind: itemKindSchema,
  name,
  currency: currencySchema,
  non_operating: z.boolean(),
  fixed: z.boolean(),
  credit_card: z.boolean(),
  loan: z.boolean(),
  archived: z.boolean(),
});
const named = z.strictObject({ ...ref, name, archived: z.boolean() });
const transaction = z.strictObject({
  ...ref,
  occurred_on: dateSchema,
  memo: z.string().max(2000),
  payee_id: idSchema.nullable(),
  project_id: idSchema.nullable(),
  invoice_no: z.string().max(100),
  kind: z.enum(['income', 'expense', 'transfer', 'adjustment']),
  source_system: z.string().nullable(),
  source_id: z.string().nullable(),
  created_at: timestamp,
});
const entry = z.strictObject({
  ...ref,
  transaction_id: idSchema,
  item_id: idSchema,
  amount,
  currency: currencySchema,
  exchange_rate: rate,
  base_amount: amount,
  entry_position: z.number().int().min(0),
});
const exchange = z.strictObject({
  ledger_id: idSchema,
  rate_date: dateSchema,
  from_currency: currencySchema,
  to_currency: currencySchema,
  rate,
  as_of_source: z.boolean(),
});
const job = z.strictObject({
  ...ref,
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_system: z.string(),
  status: z.enum(['validated', 'imported', 'failed']),
  report: z.json(),
  created_at: timestamp,
});
const sourceRecord = z.strictObject({
  ...ref,
  import_job_id: idSchema,
  source_table: z.string(),
  source_key: z.string(),
  target_table: z.enum([
    'items',
    'payees',
    'projects',
    'exchange_rates',
    'transactions',
  ]),
  target_id: z.string(),
});
const legacyTablesSchema = z.strictObject({
  items: z.array(backupItemSchema),
  payees: z.array(named),
  projects: z.array(named),
  memo_templates: z.array(named.extend({ memo: z.string().max(2000) })),
  transactions: z.array(transaction),
  transaction_entries: z.array(entry),
  exchange_rates: z.array(exchange),
  import_jobs: z.array(job),
  import_source_records: z.array(sourceRecord),
});
export const legacyBackupTableNames = [
  'items',
  'payees',
  'projects',
  'memo_templates',
  'transactions',
  'transaction_entries',
  'exchange_rates',
  'import_jobs',
  'import_source_records',
] as const;
const legacyCountsSchema = z.strictObject(
  Object.fromEntries(
    legacyBackupTableNames.map((k) => [k, z.number().int().nonnegative()]),
  ) as Record<(typeof legacyBackupTableNames)[number], z.ZodNumber>,
);
const legacyBackupSchema = z.strictObject({
  format: z.literal('life-ledger'),
  schemaVersion: z.literal(1),
  exportedAt: timestamp,
  appVersion: z.string().min(1).max(100),
  ledger: backupLedgerSchema,
  tables: legacyTablesSchema,
  counts: legacyCountsSchema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const rule = recurringRuleSchema.safeExtend({
  ...ref,
  next_on: dateSchema.nullable(),
});
const occurrence = z.strictObject({
  ...ref,
  rule_id: idSchema.nullable(),
  source_rule_id: z.string(),
  rule_name: name,
  occurs_on: dateSchema,
  occurred_on: dateSchema,
  template: recurringTemplateSchema,
  status: occurrenceStatusSchema,
  transaction_id: idSchema.nullable(),
  error_code: z.string().nullable(),
});
const budget = z.strictObject({
  ...ref,
  item_id: idSchema,
  year: z.number().int().min(1).max(9999),
  month: z.number().int().min(1).max(12),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/),
});
const v2TablesSchema = legacyTablesSchema.extend({
  recurring_rules: z.array(rule),
  recurring_occurrences: z.array(occurrence),
  budgets: z.array(budget),
});
const v2TableNames = [
  ...legacyBackupTableNames,
  'recurring_rules',
  'recurring_occurrences',
  'budgets',
] as const;
const v2CountsSchema = legacyCountsSchema.extend({
  recurring_rules: z.number().int().nonnegative(),
  recurring_occurrences: z.number().int().nonnegative(),
  budgets: z.number().int().nonnegative(),
});
const v2BackupSchema = legacyBackupSchema.extend({
  schemaVersion: z.literal(2),
  tables: v2TablesSchema,
  counts: v2CountsSchema,
});
const v3TablesSchema = v2TablesSchema.extend({
  credit_card_settings: z.array(
    cardSettingsSchema.extend({ ledger_id: idSchema }),
  ),
  loan_settings: z.array(loanSettingsSchema.extend({ ledger_id: idSchema })),
});
const v3TableNames = [
  ...v2TableNames,
  'credit_card_settings',
  'loan_settings',
] as const;
const v3CountsSchema = v2CountsSchema.extend({
  credit_card_settings: z.number().int().nonnegative(),
  loan_settings: z.number().int().nonnegative(),
});
const v3BackupSchema = v2BackupSchema.extend({
  schemaVersion: z.literal(3),
  tables: v3TablesSchema,
  counts: v3CountsSchema,
});
const integer = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .max(100);
const cents = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  .max(100);
const trade = z.strictObject({
  ...ref,
  security_id: idSchema,
  transaction_id: idSchema.nullable(),
  trade_type: z.enum(['buy', 'sell', 'stock_dividend', 'adjust']),
  trade_date: dateSchema,
  sequence: z.number().int().positive(),
  quantity: integer.nullable(),
  quantity_after: integer.nullable(),
  price: stockPrice,
  fee: cents,
  tax: cents,
  cost_mode: z.enum(['keep', 'set_cost', 'cash_return']).nullable(),
  cost_after: cents.nullable(),
  cash_amount: cents.nullable(),
  note: z.string().max(2000),
  settlement_item_id: idSchema.nullable(),
  expense_item_id: idSchema.nullable(),
  gain_item_id: idSchema.nullable(),
  gross: cents,
  cost_removed: cents,
  position_quantity: integer,
  position_cost: cents,
  realized_gain: cents,
});
const v4TablesSchema = v3TablesSchema.extend({
  items: z.array(backupItemSchema.extend({ securities: z.boolean() })),
  securities: z.array(securitySchema.extend(ref)),
  security_trades: z.array(trade),
  manual_prices: z.array(
    z.strictObject({
      ...ref,
      market: z.enum(['TWSE', 'TPEx']),
      symbol: securitySchema.shape.symbol,
      price_date: dateSchema,
      price: stockPrice,
    }),
  ),
});
const v4TableNames = [
  ...v3TableNames,
  'securities',
  'security_trades',
  'manual_prices',
] as const;
const v4CountsSchema = v3CountsSchema.extend({
  securities: z.number().int().nonnegative(),
  security_trades: z.number().int().nonnegative(),
  manual_prices: z.number().int().nonnegative(),
});
const v4BackupSchema = v3BackupSchema.extend({
  schemaVersion: z.literal(4),
  tables: v4TablesSchema,
  counts: v4CountsSchema,
});
const v5TablesSchema = v4TablesSchema.extend({
  income_codes: z.array(incomeCodeSchema.extend(ref)),
  dividends: z.array(
    z
      .strictObject(dividendSchema.shape)
      .omit({ components: true })
      .extend({
        ...ref,
        transaction_id: idSchema.nullable(),
        stock_trade_id: idSchema.nullable(),
      }),
  ),
  dividend_components: z.array(
    z.strictObject({
      ...ref,
      dividend_id: idSchema,
      code: z.string().min(1).max(100),
      label: name,
      amount: cents,
      taxable: z.boolean(),
      income_item_id: idSchema,
    }),
  ),
});
const v5TableNames = [
  ...v4TableNames,
  'income_codes',
  'dividends',
  'dividend_components',
] as const;
const v5CountsSchema = v4CountsSchema.extend({
  income_codes: z.number().int().nonnegative(),
  dividends: z.number().int().nonnegative(),
  dividend_components: z.number().int().nonnegative(),
});
const v5BackupSchema = v4BackupSchema.extend({
  schemaVersion: z.literal(5),
  tables: v5TablesSchema,
  counts: v5CountsSchema,
});
const v6TablesSchema = v5TablesSchema.extend({
  fixed_deposits: z.array(
    depositSchema.extend({
      ...ref,
      status: z.enum(['active', 'matured', 'closed']),
      renewed_from_id: idSchema.nullable(),
    }),
  ),
  deposit_postings: z.array(
    z.strictObject({
      ...ref,
      deposit_id: idSchema,
      kind: z.enum(['interest', 'settlement']),
      period_no: z.number().int().positive().nullable(),
      posted_on: dateSchema,
      gross_interest: depositMoney,
      withholding_tax: depositMoney,
      nhi_premium: depositMoney,
      renew: z.enum(['none', 'principal', 'principal_and_interest']),
      renewed_deposit_id: idSchema.nullable(),
      transaction_id: idSchema.nullable(),
    }),
  ),
});
const v6TableNames = [
  ...v5TableNames,
  'fixed_deposits',
  'deposit_postings',
] as const;
const v6CountsSchema = v5CountsSchema.extend({
  fixed_deposits: z.number().int().nonnegative(),
  deposit_postings: z.number().int().nonnegative(),
});
const v6BackupSchema = v5BackupSchema.extend({
  schemaVersion: z.literal(6),
  tables: v6TablesSchema,
  counts: v6CountsSchema,
});
const v7TablesSchema = v6TablesSchema.extend({
  reminder_settings: z
    .array(reminderSettingsSchema.extend({ ledger_id: idSchema }))
    .max(1),
  reminder_reads: z.array(
    z.strictObject({
      ledger_id: idSchema,
      key: reminderKeySchema,
      fingerprint: reminderFingerprintSchema,
      read_at: timestamp,
    }),
  ),
});
export const backupTableNames = [
  ...v6TableNames,
  'reminder_settings',
  'reminder_reads',
] as const;
export const backupCountsSchema = v6CountsSchema.extend({
  reminder_settings: z.number().int().min(0).max(1),
  reminder_reads: z.number().int().nonnegative(),
});
const v7BackupSchema = v6BackupSchema.extend({
  schemaVersion: z.literal(7),
  tables: v7TablesSchema,
  counts: backupCountsSchema,
});
export const backupTablesSchema = v7TablesSchema.extend({
  security_trades: z.array(
    trade.extend({
      origin: z.enum(['app', 'emoney']),
      source_transaction_id: idSchema.nullable(),
    }),
  ),
  import_jobs: z.array(
    job.extend({ kind: z.enum(['ledger', 'emoney-investments']) }),
  ),
  import_source_records: z.array(
    sourceRecord.extend({
      target_table: z.enum([
        'items',
        'payees',
        'projects',
        'exchange_rates',
        'transactions',
        'securities',
        'security_trades',
        'fixed_deposits',
      ]),
    }),
  ),
});
const v8BackupSchema = v7BackupSchema.extend({
  schemaVersion: z.literal(8),
  tables: backupTablesSchema,
});
export const backupSchema = v8BackupSchema.extend({
  format: z.literal('finmichi'),
  schemaVersion: z.literal(9),
});
export const backupInputSchema = z.union([
  legacyBackupSchema,
  v2BackupSchema,
  v3BackupSchema,
  v4BackupSchema,
  v5BackupSchema,
  v6BackupSchema,
  v7BackupSchema,
  v8BackupSchema,
  backupSchema,
]);
export type LedgerBackup = z.infer<typeof backupSchema>;
export type BackupTables = z.infer<typeof backupTablesSchema>;
export const restoreQuerySchema = z.strictObject({
  mode: z.enum(['full', 'structure']).default('full'),
  name: name.optional(),
});
