// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { Database } from '@finmichi/db';
import { ownedLedger, valid, DomainError, mutation } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import {
  backupSchema,
  backupTableNames,
  BACKUP_MAX_BYTES,
  BACKUP_MAX_TRANSACTIONS,
  type LedgerBackup,
} from './backup-schemas.js';
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 100) throw new DomainError('invalid_backup', 400);
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map((v) => canonicalJson(v, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            canonicalJson((value as Record<string, unknown>)[k], depth + 1),
        )
        .join(',') +
      '}'
    );
  throw new DomainError('invalid_backup', 400);
}
export const backupPayloadSha256 = (tables: unknown) =>
  createHash('sha256').update(canonicalJson(tables)).digest('hex');
export function backupFilename(name: string, at: string) {
  const slug =
    name
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'ledger';
  const time = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(at))
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(' ', '-');
  return `finmichi-${slug}-${time}.json`;
}
export function backupService(db: Database, appVersion = '0.0.1') {
  return {
    async download(actor: string, ledgerId: unknown): Promise<LedgerBackup> {
      valid(idSchema, actor);
      return mutation(db, actor, 'backup.download', async (sql) => {
        const ledger = valid(idSchema, ledgerId);
        await sql.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await ownedLedger(sql, actor, ledger);
        const [l] =
          await sql`SELECT id,name,base_currency,locked_until::text,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM ledgers WHERE id=${ledger}`;
        const items =
          await sql`SELECT id,ledger_id,parent_id,kind,name,currency,non_operating,fixed,credit_card,loan,archived,securities FROM items WHERE ledger_id=${ledger} ORDER BY id`;
        const payees =
          await sql`SELECT id,ledger_id,name,archived FROM payees WHERE ledger_id=${ledger} ORDER BY id`;
        const projects =
          await sql`SELECT id,ledger_id,name,archived FROM projects WHERE ledger_id=${ledger} ORDER BY id`;
        const memo_templates =
          await sql`SELECT id,ledger_id,name,archived,memo FROM memo_templates WHERE ledger_id=${ledger} ORDER BY id`;
        const transactions =
          await sql`SELECT id,ledger_id,occurred_on::text,memo,payee_id,project_id,invoice_no,kind,source_system,source_id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM transactions WHERE ledger_id=${ledger} ORDER BY id LIMIT ${BACKUP_MAX_TRANSACTIONS + 1}`;
        if (transactions.length > BACKUP_MAX_TRANSACTIONS)
          throw new DomainError('backup_too_large', 413);
        const transaction_entries =
          await sql`SELECT id,ledger_id,transaction_id,item_id,amount::text,currency,exchange_rate::text,base_amount::text,entry_position FROM transaction_entries WHERE ledger_id=${ledger} ORDER BY transaction_id,entry_position`;
        const exchange_rates =
          await sql`SELECT ledger_id,rate_date::text,from_currency,to_currency,rate::text,as_of_source FROM exchange_rates WHERE ledger_id=${ledger} ORDER BY rate_date,from_currency,to_currency`;
        const import_jobs =
          await sql`SELECT id,ledger_id,source_sha256,source_system,kind,status,report,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM import_jobs WHERE ledger_id=${ledger} ORDER BY id`;
        const import_source_records =
          await sql`SELECT id,ledger_id,import_job_id,source_table,source_key,target_table,target_id FROM import_source_records WHERE ledger_id=${ledger} ORDER BY id`;
        const recurring_rules =
          await sql`SELECT id,ledger_id,name,template,frequency,interval,day_of_month,weekday,month,day,start_on::text,end_on::text,active,auto_post,next_on::text FROM recurring_rules WHERE ledger_id=${ledger} ORDER BY id`;
        const recurring_occurrences =
          await sql`SELECT id,ledger_id,rule_id,source_rule_id,rule_name,occurs_on::text,occurred_on::text,template,status,transaction_id,error_code FROM recurring_occurrences WHERE ledger_id=${ledger} ORDER BY source_rule_id,occurs_on`;
        const budgets =
          await sql`SELECT id,ledger_id,item_id,year,month,amount::text FROM budgets WHERE ledger_id=${ledger} ORDER BY year,item_id,month`;
        const credit_card_settings =
          await sql`SELECT item_id,ledger_id,statement_day,due_day,due_month_offset,payment_account_id,credit_limit::text FROM credit_card_settings WHERE ledger_id=${ledger} ORDER BY item_id`;
        const loan_settings =
          await sql`SELECT item_id,ledger_id,principal::text,annual_rate::text,term_months,first_payment_on::text,method,payment_account_id,interest_item_id FROM loan_settings WHERE ledger_id=${ledger} ORDER BY item_id`;
        const securities =
          await sql`SELECT id,ledger_id,symbol,name,market,kind,item_id,archived FROM securities WHERE ledger_id=${ledger} ORDER BY id`;
        const security_trades =
          await sql`SELECT id,ledger_id,security_id,origin,source_transaction_id,transaction_id,trade_type,trade_date::text,sequence,quantity::text,quantity_after::text,price::text,fee::text,tax::text,cost_mode,cost_after::text,cash_amount::text,note,settlement_item_id,expense_item_id,gain_item_id,gross::text,cost_removed::text,position_quantity::text,position_cost::text,realized_gain::text FROM security_trades WHERE ledger_id=${ledger} ORDER BY security_id,trade_date,sequence`;
        const manual_prices =
          await sql`SELECT id,ledger_id,market,symbol,price_date::text,price::text FROM manual_prices WHERE ledger_id=${ledger} ORDER BY id`;
        const income_codes =
          await sql`SELECT id,ledger_id,code,label,income_item_id FROM income_codes WHERE ledger_id=${ledger} ORDER BY id`;
        const dividends =
          await sql`SELECT d.*,ex_date::text,pay_date::text,per_share::text,shares::text,gross_amount::text,withholding_tax::text,nhi_premium::text,fee::text,net_amount::text,stock_shares::text FROM dividends d WHERE ledger_id=${ledger} ORDER BY id`;
        const dividend_components =
          await sql`SELECT id,ledger_id,dividend_id,code,label,amount::text,taxable,income_item_id FROM dividend_components WHERE ledger_id=${ledger} ORDER BY id`;
        const fixed_deposits =
          await sql`SELECT *,principal::text,annual_rate::text,start_on::text,maturity_on::text FROM fixed_deposits WHERE ledger_id=${ledger} ORDER BY id`;
        const deposit_postings =
          await sql`SELECT *,posted_on::text,gross_interest::text,withholding_tax::text,nhi_premium::text FROM deposit_postings WHERE ledger_id=${ledger} ORDER BY id`;
        const reminder_settings =
          await sql`SELECT * FROM reminder_settings WHERE ledger_id=${ledger}`;
        const reminder_reads =
          await sql`SELECT ledger_id,key,fingerprint,to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at FROM reminder_reads WHERE ledger_id=${ledger} ORDER BY key`;
        const tables = {
          reminder_settings,
          reminder_reads,
          fixed_deposits,
          deposit_postings,
          income_codes,
          dividends,
          dividend_components,
          securities,
          security_trades,
          manual_prices,
          credit_card_settings,
          loan_settings,
          recurring_rules,
          recurring_occurrences,
          budgets,
          items,
          payees,
          projects,
          memo_templates,
          transactions,
          transaction_entries,
          exchange_rates,
          import_jobs,
          import_source_records,
        };
        const parsed = backupSchema.safeParse({
          format: 'finmichi',
          schemaVersion: 9,
          exportedAt: new Date().toISOString(),
          appVersion,
          ledger: l,
          tables,
          counts: Object.fromEntries(
            backupTableNames.map((k) => [k, tables[k].length]),
          ),
          payloadSha256: '0'.repeat(64),
        });
        if (!parsed.success) throw new DomainError('backup_invalid_data', 400);
        const result = parsed.data;
        result.payloadSha256 = backupPayloadSha256(result.tables);
        if (Buffer.byteLength(JSON.stringify(result)) > BACKUP_MAX_BYTES)
          throw new DomainError('backup_too_large', 413);
        return result;
      });
    },
  };
}
