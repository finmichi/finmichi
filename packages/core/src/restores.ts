// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type { Database } from '@finmichi/db';
import { mutation, valid } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import {
  backupTableNames,
  restoreQuerySchema,
  type BackupTables,
} from './backup-schemas.js';
import { nextOccurrence } from './recurring-calendar.js';
import { recurringSource } from './backup-validation.js';
import type { RecurringTemplate } from './recurring-schemas.js';
import { validateBackup, defaultRestoreName } from './backup-validation.js';
const uuidTables = [
  'items',
  'payees',
  'projects',
  'memo_templates',
  'transactions',
  'transaction_entries',
  'import_jobs',
  'import_source_records',
  'recurring_rules',
  'recurring_occurrences',
  'budgets',
  'securities',
  'security_trades',
  'manual_prices',
  'income_codes',
  'dividends',
  'dividend_components',
  'fixed_deposits',
  'deposit_postings',
] as const;
const structures = new Set<string>([
  'reminder_settings',
  'items',
  'payees',
  'projects',
  'memo_templates',
  'recurring_rules',
  'budgets',
  'credit_card_settings',
  'loan_settings',
  'securities',
  'income_codes',
  'fixed_deposits',
]);
async function batches<T>(
  rows: T[],
  save: (batch: T[]) => PromiseLike<unknown>,
) {
  for (let i = 0; i < rows.length; i += 500) await save(rows.slice(i, i + 500));
}
function selectedCounts(tables: BackupTables, mode: 'full' | 'structure') {
  return Object.fromEntries(
    backupTableNames.map((k) => [
      k,
      mode === 'full' || structures.has(k) ? tables[k].length : 0,
    ]),
  );
}
export function restoreService(db: Database) {
  return {
    async preview(actor: string, input: unknown, query: unknown = {}) {
      valid(idSchema, actor);
      const q = valid(restoreQuerySchema, query),
        { backup, dangling, deleted, history, sourceVersion } =
          validateBackup(input);
      let from: string | null = null,
        to: string | null = null;
      for (const row of backup.tables.transactions) {
        if (from === null || row.occurred_on < from) from = row.occurred_on;
        if (to === null || row.occurred_on > to) to = row.occurred_on;
      }
      return {
        mode: q.mode,
        source_schema_version: sourceVersion,
        recurring_history: history,
        default_name: q.name ?? defaultRestoreName(backup.ledger.name),
        base_currency: backup.ledger.base_currency,
        locked_until: q.mode === 'full' ? backup.ledger.locked_until : null,
        source_locked_until: backup.ledger.locked_until,
        counts: backup.counts,
        restore_counts: selectedCounts(backup.tables, q.mode),
        date_range: { from, to },
        dangling_targets: dangling,
        deleted_targets: deleted,
      };
    },
    async confirm(actor: string, input: unknown, query: unknown = {}) {
      return mutation(db, actor, 'backup.restore', async (sql) => {
        const q = valid(restoreQuerySchema, query);
        const { backup } = validateBackup(input),
          t = backup.tables,
          ledger = randomUUID(),
          name = q.name ?? defaultRestoreName(backup.ledger.name),
          locked = q.mode === 'full' ? backup.ledger.locked_until : null;
        const maps = new Map<string, Map<string, string>>();
        for (const table of uuidTables)
          maps.set(
            table,
            new Map(
              (q.mode === 'full' || structures.has(table) ? t[table] : []).map(
                (r) => [r.id.toLowerCase(), randomUUID()],
              ),
            ),
          );
        if (q.mode === 'full') {
          const rules = maps.get('recurring_rules')!;
          const old = [
            ...t.recurring_occurrences.map((r) => r.source_rule_id),
            ...t.transactions
              .filter((r) => r.source_system === 'recurring')
              .map((r) => recurringSource(r.source_id)!.rule),
          ];
          for (const source of old)
            if (!rules.has(source.toLowerCase()))
              rules.set(source.toLowerCase(), randomUUID());
        }
        const id = (table: (typeof uuidTables)[number], old: string) =>
          maps.get(table)!.get(old.toLowerCase())!;
        await sql`INSERT INTO ledgers(id,owner_id,name,base_currency,locked_until,created_at) VALUES (${ledger},${actor},${name},${backup.ledger.base_currency},${locked},${backup.ledger.created_at}::text::timestamptz)`;
        await batches(
          t.reminder_settings.map((r) => ({ ...r, ledger_id: ledger })),
          (rows) => sql`INSERT INTO reminder_settings ${sql(rows)}`,
        );
        if (q.mode === 'full') {
          const reads = t.reminder_reads.flatMap((r) => {
            const [kind, old, ...suffix] = r.key.split(':');
            if (kind === 'market') return [{ ...r, ledger_id: ledger }];
            const table = (
              {
                deposit: 'fixed_deposits',
                card: 'items',
                loan: 'items',
                occurrence: 'recurring_occurrences',
              } as const
            )[kind as 'deposit'];
            const mapped =
              table && old
                ? maps.get(table)?.get(old.toLowerCase())
                : undefined;
            // Drafts and disappeared references are deliberately not restored. Fingerprints remain
            // content hashes; changed payload UUIDs correctly make recurring reminders unread again.
            return mapped
              ? [
                  {
                    ...r,
                    ledger_id: ledger,
                    key: [kind, mapped, ...suffix].join(':'),
                  },
                ]
              : [];
          });
          await batches(
            reads,
            (rows) => sql`INSERT INTO reminder_reads ${sql(rows)}`,
          );
        }
        await batches(
          t.items.map((r) => ({
            ...r,
            id: id('items', r.id),
            ledger_id: ledger,
            parent_id: null,
          })),
          (rows) => sql`INSERT INTO items ${sql(rows)}`,
        );
        for (const r of t.items)
          if (r.parent_id)
            await sql`UPDATE items SET parent_id=${id('items', r.parent_id)} WHERE id=${id('items', r.id)} AND ledger_id=${ledger}`;
        await batches(
          t.payees.map((r) => ({
            ...r,
            id: id('payees', r.id),
            ledger_id: ledger,
          })),
          (rows) => sql`INSERT INTO payees ${sql(rows)}`,
        );
        await batches(
          t.projects.map((r) => ({
            ...r,
            id: id('projects', r.id),
            ledger_id: ledger,
          })),
          (rows) => sql`INSERT INTO projects ${sql(rows)}`,
        );
        await batches(
          t.memo_templates.map((r) => ({
            ...r,
            id: id('memo_templates', r.id),
            ledger_id: ledger,
          })),
          (rows) => sql`INSERT INTO memo_templates ${sql(rows)}`,
        );
        await batches(
          t.income_codes.map((r) => ({
            ...r,
            id: id('income_codes', r.id),
            ledger_id: ledger,
            income_item_id: r.income_item_id
              ? id('items', r.income_item_id)
              : null,
          })),
          (rows) => sql`INSERT INTO income_codes ${sql(rows)}`,
        );
        await batches(
          t.fixed_deposits.map((r) => ({
            ...r,
            id: id('fixed_deposits', r.id),
            ledger_id: ledger,
            item_id: id('items', r.item_id),
            payout_account_id: id('items', r.payout_account_id),
            interest_item_id: id('items', r.interest_item_id),
            renewed_from_id: r.renewed_from_id
              ? id('fixed_deposits', r.renewed_from_id)
              : null,
          })),
          (rows) => sql`INSERT INTO fixed_deposits ${sql(rows)}`,
        );
        const template = (r: RecurringTemplate): RecurringTemplate => ({
          ...r,
          payee_id: r.payee_id ? id('payees', r.payee_id) : null,
          project_id: r.project_id ? id('projects', r.project_id) : null,
          entries: r.entries.map((e) => ({
            ...e,
            item_id: id('items', e.item_id),
          })),
        });
        await batches(
          t.recurring_rules.map((r) => ({
            ...r,
            id: id('recurring_rules', r.id),
            ledger_id: ledger,
            template: template(r.template),
            active: q.mode === 'structure' ? false : r.active,
            next_on: q.mode === 'structure' ? nextOccurrence(r) : r.next_on,
          })),
          (
            rows,
          ) => sql`INSERT INTO recurring_rules(id,ledger_id,name,template,frequency,interval,day_of_month,weekday,month,day,start_on,end_on,active,auto_post,next_on)
          SELECT id,ledger_id,name,template,frequency,interval,day_of_month,weekday,month,day,start_on,end_on,active,auto_post,next_on FROM jsonb_to_recordset(${sql.json(rows)}) AS r(id uuid,ledger_id uuid,name text,template jsonb,frequency text,interval integer,day_of_month integer,weekday integer,month integer,day integer,start_on date,end_on date,active boolean,auto_post boolean,next_on date)`,
        );
        await batches(
          t.budgets.map((r) => ({
            ...r,
            id: id('budgets', r.id),
            ledger_id: ledger,
            item_id: id('items', r.item_id),
          })),
          (rows) => sql`INSERT INTO budgets ${sql(rows)}`,
        );
        await batches(
          t.credit_card_settings.map((r) => ({
            ...r,
            ledger_id: ledger,
            item_id: id('items', r.item_id),
            payment_account_id: r.payment_account_id
              ? id('items', r.payment_account_id)
              : null,
          })),
          (rows) => sql`INSERT INTO credit_card_settings ${sql(rows)}`,
        );
        await batches(
          t.loan_settings.map((r) => ({
            ...r,
            ledger_id: ledger,
            item_id: id('items', r.item_id),
            payment_account_id: id('items', r.payment_account_id),
            interest_item_id: id('items', r.interest_item_id),
          })),
          (rows) => sql`INSERT INTO loan_settings ${sql(rows)}`,
        );
        await batches(
          t.securities.map((r) => ({
            ...r,
            id: id('securities', r.id),
            ledger_id: ledger,
            item_id: id('items', r.item_id),
          })),
          (rows) => sql`INSERT INTO securities ${sql(rows)}`,
        );
        if (q.mode === 'full') {
          await batches(
            t.exchange_rates.map((r) => ({ ...r, ledger_id: ledger })),
            (rows) => sql`INSERT INTO exchange_rates ${sql(rows)}`,
          );
          await batches(
            t.import_jobs.map((r) => ({
              ...r,
              id: id('import_jobs', r.id),
              ledger_id: ledger,
              report:
                r.kind === 'emoney-investments' &&
                r.report &&
                typeof r.report === 'object' &&
                !Array.isArray(r.report) &&
                typeof r.report.securities_item === 'string'
                  ? {
                      ...r.report,
                      securities_item: id('items', r.report.securities_item),
                      ...(Array.isArray(r.report.created_item_ids)
                        ? {
                            created_item_ids: r.report.created_item_ids
                              .filter(
                                (value): value is string =>
                                  typeof value === 'string',
                              )
                              .map((value) => id('items', value))
                              .filter(Boolean),
                          }
                        : {}),
                    }
                  : r.report,
            })),
            (
              rows,
            ) => sql`INSERT INTO import_jobs(id,ledger_id,source_sha256,source_system,kind,status,report,created_at)
            SELECT id,ledger_id,source_sha256,source_system,kind,status,report,created_at FROM jsonb_to_recordset(${sql.json(rows)})
            AS r(id uuid,ledger_id uuid,source_sha256 text,source_system text,kind text,status text,report jsonb,created_at timestamptz)`,
          );
          await batches(
            t.transactions.map((r) => {
              let source_id = r.source_id;
              // Explicit allowlist: external source ids (e.g. emoney-mdb) remain untouched.
              if (r.source_system === 'deposit')
                source_id = id('deposit_postings', r.source_id!);
              if (r.source_system === 'recurring') {
                const source = recurringSource(source_id)!;
                source_id =
                  id('recurring_rules', source.rule) + ':' + source.date;
              }
              if (r.source_system === 'life2023-csv') {
                const colon = source_id!.indexOf(':');
                source_id =
                  id('import_jobs', source_id!.slice(0, colon)) +
                  source_id!.slice(colon);
              }
              return {
                ...r,
                id: id('transactions', r.id),
                ledger_id: ledger,
                payee_id: r.payee_id ? id('payees', r.payee_id) : null,
                project_id: r.project_id ? id('projects', r.project_id) : null,
                source_id,
              };
            }),
            (
              rows,
            ) => sql`INSERT INTO transactions(id,ledger_id,occurred_on,memo,payee_id,project_id,invoice_no,kind,source_system,source_id,created_at)
            SELECT id,ledger_id,occurred_on,memo,payee_id,project_id,invoice_no,kind,source_system,source_id,created_at FROM jsonb_to_recordset(${sql.json(rows)})
            AS r(id uuid,ledger_id uuid,occurred_on date,memo text,payee_id uuid,project_id uuid,invoice_no text,kind text,source_system text,source_id text,created_at timestamptz)`,
          );
          await batches(
            t.transaction_entries.map((r) => ({
              ...r,
              id: id('transaction_entries', r.id),
              ledger_id: ledger,
              item_id: id('items', r.item_id),
              transaction_id: id('transactions', r.transaction_id),
            })),
            (rows) => sql`INSERT INTO transaction_entries ${sql(rows)}`,
          );
          await batches(
            t.deposit_postings.map((r) => ({
              ...r,
              id: id('deposit_postings', r.id),
              ledger_id: ledger,
              deposit_id: id('fixed_deposits', r.deposit_id),
              renewed_deposit_id: r.renewed_deposit_id
                ? id('fixed_deposits', r.renewed_deposit_id)
                : null,
              transaction_id: r.transaction_id
                ? id('transactions', r.transaction_id)
                : null,
            })),
            (rows) => sql`INSERT INTO deposit_postings ${sql(rows)}`,
          );
          await batches(
            t.security_trades.map((r) => ({
              ...r,
              id: id('security_trades', r.id),
              ledger_id: ledger,
              security_id: id('securities', r.security_id),
              source_transaction_id:
                r.source_transaction_id &&
                maps
                  .get('transactions')!
                  .has(r.source_transaction_id.toLowerCase())
                  ? id('transactions', r.source_transaction_id)
                  : null,
              transaction_id: r.transaction_id
                ? id('transactions', r.transaction_id)
                : null,
              settlement_item_id: r.settlement_item_id
                ? id('items', r.settlement_item_id)
                : null,
              expense_item_id: r.expense_item_id
                ? id('items', r.expense_item_id)
                : null,
              gain_item_id: r.gain_item_id ? id('items', r.gain_item_id) : null,
            })),
            (rows) => sql`INSERT INTO security_trades ${sql(rows)}`,
          );
          await batches(
            t.manual_prices.map((r) => ({
              ...r,
              id: id('manual_prices', r.id),
              ledger_id: ledger,
            })),
            (rows) => sql`INSERT INTO manual_prices ${sql(rows)}`,
          );
          await batches(
            t.dividends.map((r) => ({
              ...r,
              id: id('dividends', r.id),
              ledger_id: ledger,
              security_id: id('securities', r.security_id),
              transaction_id: r.transaction_id
                ? id('transactions', r.transaction_id)
                : null,
              stock_trade_id: r.stock_trade_id
                ? id('security_trades', r.stock_trade_id)
                : null,
              settlement_item_id: r.settlement_item_id
                ? id('items', r.settlement_item_id)
                : null,
              default_income_item_id: r.default_income_item_id
                ? id('items', r.default_income_item_id)
                : null,
              tax_item_id: r.tax_item_id ? id('items', r.tax_item_id) : null,
              expense_item_id: r.expense_item_id
                ? id('items', r.expense_item_id)
                : null,
            })),
            (rows) => sql`INSERT INTO dividends ${sql(rows)}`,
          );
          await batches(
            t.dividend_components.map((r) => ({
              ...r,
              id: id('dividend_components', r.id),
              ledger_id: ledger,
              dividend_id: id('dividends', r.dividend_id),
              income_item_id: id('items', r.income_item_id),
            })),
            (rows) => sql`INSERT INTO dividend_components ${sql(rows)}`,
          );
          const targets = new Set(
            t.exchange_rates.map(
              (r) => `${r.rate_date}|${r.from_currency}|${r.to_currency}`,
            ),
          );
          await batches(
            t.import_source_records.map((r) => {
              let target_id = r.target_id;
              if (!target_id.startsWith('deleted:')) {
                if (r.target_table === 'exchange_rates') {
                  if (!targets.has(target_id))
                    target_id = 'deleted:' + target_id;
                } else
                  target_id =
                    maps.get(r.target_table)!.get(target_id.toLowerCase()) ??
                    'deleted:' + target_id;
              }
              return {
                ...r,
                id: id('import_source_records', r.id),
                ledger_id: ledger,
                import_job_id: id('import_jobs', r.import_job_id),
                target_id,
              };
            }),
            (rows) => sql`INSERT INTO import_source_records ${sql(rows)}`,
          );
        }
        if (q.mode === 'full')
          await batches(
            t.recurring_occurrences.map((r) => ({
              ...r,
              id: id('recurring_occurrences', r.id),
              ledger_id: ledger,
              rule_id: r.rule_id ? id('recurring_rules', r.rule_id) : null,
              source_rule_id: id('recurring_rules', r.source_rule_id),
              transaction_id: r.transaction_id
                ? id('transactions', r.transaction_id)
                : null,
              template: template(r.template),
            })),
            (
              rows,
            ) => sql`INSERT INTO recurring_occurrences(id,ledger_id,rule_id,source_rule_id,rule_name,occurs_on,occurred_on,template,status,transaction_id,error_code)
          SELECT id,ledger_id,rule_id,source_rule_id,rule_name,occurs_on,occurred_on,template,status,transaction_id,error_code FROM jsonb_to_recordset(${sql.json(rows)}) AS r(id uuid,ledger_id uuid,rule_id uuid,source_rule_id uuid,rule_name text,occurs_on date,occurred_on date,template jsonb,status text,transaction_id uuid,error_code text)`,
          );
        // Constraints stay enabled, including deferred transaction balance checks at commit.
        return {
          ledger: {
            id: ledger,
            name,
            base_currency: backup.ledger.base_currency,
            locked_until: locked,
          },
          mode: q.mode,
          counts: selectedCounts(t, q.mode),
          id_map: {
            ledger: { [backup.ledger.id]: ledger },
            source_rules:
              q.mode === 'full'
                ? Object.fromEntries(maps.get('recurring_rules')!)
                : {},
            ...Object.fromEntries(
              uuidTables.map((table) => [
                table,
                Object.fromEntries(
                  (q.mode === 'full' || structures.has(table)
                    ? t[table]
                    : []
                  ).map((r) => [r.id, id(table, r.id)]),
                ),
              ]),
            ),
          },
        };
      });
    },
  };
}
