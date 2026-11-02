// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
export const identitySchema = z.object({
  sub: z.string().min(1),
  iss: z.string().url(),
});
export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const isAllowed = (subject: string, allowed: readonly string[]) =>
  allowed.includes(subject);
export const sameOrigin = (origin: string | undefined, expected: string) =>
  origin === new URL(expected).origin;
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const IDLE_SECONDS = 24 * 60 * 60;
export { sessionService } from './sessions.js';
export {
  moneyUnits,
  formatMoney,
  sumMoney,
  assertBalanced,
  roundHalfUp,
  MoneyError,
  calculateBaseAmounts,
  calculateImportBaseAmounts,
} from './money.js';
export type { MoneyEntry, CalculatedEntry, MoneyCalculation } from './money.js';

export { workerRetryDelay, runRecurringWorker } from './recurring-worker.js';
export { recurringService } from './recurring.js';
export { ledgerService, DomainError } from './catalog.js';
export { itemService } from './items.js';
export { namedRecordService, type NamedTable } from './named-records.js';

export { transactionService } from './transactions.js';

export { queryService } from './queries.js';

export { queryCsv } from './query-csv.js';

export { reportService } from './reports.js';
export {
  balanceReportCsv,
  incomeReportCsv,
  categoryReportCsv,
} from './report-csv.js';

export { life2023Service } from './life2023.js';

export { life2023Export } from './life2023-export.js';

export {
  backupService,
  canonicalJson,
  backupPayloadSha256,
  backupFilename,
} from './backups.js';

export { restoreService } from './restores.js';
export { BackupReferenceError } from './backup-validation.js';

export { auditService } from './audits.js';

export * from './pats.js';
export * from './pat-schemas.js';

export * from './mcp.js';
export * from './mcp-schemas.js';

export * from './budgets.js';
export * from './budget-schemas.js';

export { budgetReportCsv } from './report-csv.js';

export {
  profitLossCsv,
  netWorthFlowCsv,
  accountLedgerCsv,
} from './report-csv.js';

export * from './finance.js';
export * from './finance-schemas.js';
export * from './finance-calendar.js';

export * from './cash-forecast.js';
export * from './cash-forecast-schemas.js';

export * from './drafts.js';
export * from './draft-schemas.js';

export * from './market-schemas.js';
export * from './market-math.js';
export * from './market-parse.js';
export * from './market-fetch.js';

export * from './market-store.js';
export * from './market-worker.js';

export { securityService } from './securities.js';
export type { TradeRow } from './securities.js';
export * from './securities-schemas.js';

export { securityReports } from './securities-read.js';

export type { StockHolding } from './securities-read.js';

export * from './dividends.js';
export * from './dividend-schemas.js';
export * from './dividend-math.js';

export * from './deposits.js';
export * from './deposit-schemas.js';
export * from './deposit-math.js';

export { reminderService } from './reminders.js';
export type { RemindersResult, ReminderSettings } from './reminder-schemas.js';

export { taipeiToday } from './ledger-lock.js';
export * from './data-reset.js';
