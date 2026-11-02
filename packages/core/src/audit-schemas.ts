// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
export const auditActions = [
  'login',
  'logout',
  'ledger.create',
  'ledger.update',
  'ledger.lock',
  'ledger.unlock',
  'ledger.delete',
  'item.create',
  'item.update',
  'payees.create',
  'payees.update',
  'payees.delete',
  'projects.create',
  'projects.update',
  'projects.delete',
  'memo_templates.create',
  'memo_templates.update',
  'memo_templates.delete',
  'transaction.create',
  'transaction.update',
  'transaction.delete',
  'life2023.import',
  'emoney.import',
  'emoney.import_investments',
  'backup.restore',
  'backup.download',
  'pat.create',
  'pat.revoke',
  'mcp.call',
  'market.fx_upload',
  'draft.create',
  'draft.approve',
  'draft.reject',
  'draft.expire',
  'recurring.create',
  'recurring.update',
  'recurring.delete',
  'recurring.generate',
  'recurring.post',
  'recurring.skip',
  'budget.update',
  'budget.delete',
  'card.update',
  'card.delete',
  'loan.update',
  'loan.delete',
  'security.create',
  'security.update',
  'security.delete',
  'security.price_update',
  'security.price_delete',
  'security.trade_create',
  'security.trade_update',
  'security.trade_delete',
  'security.recalculate',
  'dividend.create',
  'dividend.update',
  'dividend.delete',
  'income_code.create',
  'income_code.update',
  'income_code.delete',
  'income_code.initialize',
  'reminder.settings_update',
  'deposit.create',
  'deposit.update',
  'deposit.delete',
  'deposit.interest',
  'deposit.settle',
  'deposit.revoke',
] as const;
export const auditActionSchema = z.enum(auditActions);
export type AuditAction = z.infer<typeof auditActionSchema>;
export const auditOutcomeSchema = z.enum(['success', 'denied', 'error']);
export const auditIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine(
    (s) => /^[1-9]\d{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n,
  );
const timestamp = z.iso
  .datetime({ offset: true })
  .refine(
    (s) => !s.startsWith('0000') && (s.match(/\.(\d+)/)?.[1]?.length ?? 0) <= 6,
  );
function micros(s: string) {
  const fraction = (s.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0');
  return BigInt(Date.parse(s)) * 1000n + BigInt(fraction.slice(3));
}
export const auditQuerySchema = z
  .strictObject({
    from: timestamp.optional(),
    to: timestamp.optional(),
    action: auditActionSchema.optional(),
    outcome: auditOutcomeSchema.optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .refine((n) => n <= 100)
      .default(25),
    cursor: z.string().max(2048).optional(),
  })
  .refine(
    (q) =>
      !q.from ||
      !q.to ||
      (Number.isFinite(Date.parse(q.from)) &&
        Number.isFinite(Date.parse(q.to)) &&
        micros(q.from) <= micros(q.to)),
  );
export interface AuditRow {
  id: string;
  action: AuditAction;
  outcome: z.infer<typeof auditOutcomeSchema>;
  created_at: string;
}
export interface AuditPage {
  items: AuditRow[];
  next_cursor: string | null;
}
