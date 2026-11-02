// SPDX-License-Identifier: AGPL-3.0-only
import { DomainError } from './catalog.js';
import { dateSchema } from './transaction-schemas.js';
import { idSchema } from './catalog-schemas.js';
import { canonicalJson, backupPayloadSha256 } from './backups.js';
import {
  backupInputSchema,
  backupTableNames,
  BACKUP_MAX_BYTES,
  BACKUP_MAX_TRANSACTIONS,
  type LedgerBackup,
  type BackupTables,
} from './backup-schemas.js';
export interface ReferenceIssue {
  table: string;
  index: number;
  field: string;
  code: string;
}
export class BackupReferenceError extends DomainError {
  constructor(
    public readonly issues: ReferenceIssue[],
    public readonly issueCount: number,
  ) {
    super('reference_invalid', 400);
  }
}
export const exchangeTargetKey = (
  row: BackupTables['exchange_rates'][number],
) => `${row.rate_date}|${row.from_currency}|${row.to_currency}`;
export const exchangeTargetPattern = /^\d{4}-\d{2}-\d{2}\|[A-Z]{3}\|[A-Z]{3}$/;
export function validateBackup(input: unknown) {
  const serialized = canonicalJson(input);
  if (Buffer.byteLength(serialized) > BACKUP_MAX_BYTES)
    throw new DomainError('backup_too_large', 413);
  if (
    input &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    input.schemaVersion !== 1 &&
    input.schemaVersion !== 2 &&
    input.schemaVersion !== 3 &&
    input.schemaVersion !== 4 &&
    input.schemaVersion !== 5 &&
    input.schemaVersion !== 6 &&
    input.schemaVersion !== 7 &&
    input.schemaVersion !== 8 &&
    input.schemaVersion !== 9
  )
    throw new DomainError('backup_schema_unsupported', 400);
  if (
    input &&
    typeof input === 'object' &&
    'tables' in input &&
    input.tables &&
    typeof input.tables === 'object' &&
    'transactions' in input.tables &&
    Array.isArray(input.tables.transactions) &&
    input.tables.transactions.length > BACKUP_MAX_TRANSACTIONS
  )
    throw new DomainError('backup_too_large', 413);
  const parsed = backupInputSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('invalid_backup', 400);
  const source = parsed.data;
  // Validate the original v1/v2 payload before adding empty P2 tables/defaults.
  const raw = input as { tables: unknown };
  if (source.payloadSha256 !== backupPayloadSha256(raw.tables))
    throw new DomainError('backup_checksum_mismatch', 400);
  const backup: LedgerBackup = {
    ...source,
    format: 'finmichi',
    schemaVersion: 9,
    tables: {
      ...source.tables,
      ...(source.schemaVersion < 8
        ? {
            import_jobs: source.tables.import_jobs.map((r) => ({
              ...r,
              kind: 'ledger' as const,
            })),
            security_trades:
              'security_trades' in source.tables
                ? source.tables.security_trades.map((r) => ({
                    ...r,
                    origin: 'app' as const,
                    source_transaction_id: null,
                  }))
                : [],
          }
        : {}),
      ...(source.schemaVersion < 7
        ? { reminder_settings: [], reminder_reads: [] }
        : {}),
      ...(source.schemaVersion < 6
        ? { fixed_deposits: [], deposit_postings: [] }
        : {}),
      ...(source.schemaVersion < 5
        ? { income_codes: [], dividends: [], dividend_components: [] }
        : {}),
      ...(source.schemaVersion < 4
        ? {
            items: source.tables.items.map((r) => ({
              ...r,
              securities: false,
            })),
            securities: [],
            security_trades: [],
            manual_prices: [],
          }
        : {}),
      ...(source.schemaVersion === 1
        ? { recurring_rules: [], recurring_occurrences: [], budgets: [] }
        : {}),
      ...(source.schemaVersion < 3
        ? { credit_card_settings: [], loan_settings: [] }
        : {}),
    },
    counts: {
      ...source.counts,
      ...(source.schemaVersion < 7
        ? { reminder_settings: 0, reminder_reads: 0 }
        : {}),
      ...(source.schemaVersion < 6
        ? { fixed_deposits: 0, deposit_postings: 0 }
        : {}),
      ...(source.schemaVersion < 5
        ? { income_codes: 0, dividends: 0, dividend_components: 0 }
        : {}),
      ...(source.schemaVersion < 4
        ? { securities: 0, security_trades: 0, manual_prices: 0 }
        : {}),
      ...(source.schemaVersion === 1
        ? { recurring_rules: 0, recurring_occurrences: 0, budgets: 0 }
        : {}),
      ...(source.schemaVersion < 3
        ? { credit_card_settings: 0, loan_settings: 0 }
        : {}),
    },
  } as LedgerBackup;
  backup.payloadSha256 = backupPayloadSha256(backup.tables);
  if (backup.tables.transactions.length > BACKUP_MAX_TRANSACTIONS)
    throw new DomainError('backup_too_large', 413);
  for (const table of backupTableNames)
    if (backup.counts[table] !== backup.tables[table].length)
      throw new DomainError('backup_count_mismatch', 400);
  return {
    backup,
    sourceVersion: source.schemaVersion,
    ...validateReferences(backup),
  };
}
export function validateReferences(backup: LedgerBackup) {
  const tables = backup.tables,
    issues: ReferenceIssue[] = [];
  let issueCount = 0;
  function issue(table: string, index: number, field: string, code: string) {
    issueCount++;
    if (issues.length < 20) issues.push({ table, index, field, code });
  }
  const sets = new Map<string, Set<string>>();
  for (const table of backupTableNames) {
    const ids = new Set<string>();
    sets.set(table, ids);
    tables[table].forEach((r, index) => {
      if (r.ledger_id.toLowerCase() !== backup.ledger.id.toLowerCase())
        issue(table, index, 'ledger_id', 'ledger_mismatch');
      const id =
        'id' in r
          ? r.id.toLowerCase()
          : 'item_id' in r
            ? r.item_id.toLowerCase()
            : 'rate_date' in r
              ? exchangeTargetKey(r)
              : 'key' in r
                ? r.key
                : r.ledger_id;
      if (ids.has(id)) issue(table, index, 'id', 'duplicate_id');
      ids.add(id);
    });
  }
  const has = (table: string, id: string) =>
    sets.get(table)!.has(table === 'exchange_rates' ? id : id.toLowerCase());
  function ref(
    table: string,
    index: number,
    field: string,
    target: string,
    id: string | null,
  ) {
    if (id !== null && !has(target, id))
      issue(table, index, field, 'missing_reference');
  }
  tables.items.forEach((r, i) =>
    ref('items', i, 'parent_id', 'items', r.parent_id),
  );
  const history = {
    deleted_rule_occurrences: 0,
    posted_without_transaction: 0,
    deleted_rule_transactions: 0,
  };
  function templateRefs(
    table: string,
    index: number,
    template: BackupTables['recurring_rules'][number]['template'],
  ) {
    ref(table, index, 'template.payee_id', 'payees', template.payee_id);
    ref(table, index, 'template.project_id', 'projects', template.project_id);
    template.entries.forEach((e) =>
      ref(table, index, 'template.entries.item_id', 'items', e.item_id),
    );
  }
  tables.recurring_rules.forEach((r, i) =>
    templateRefs('recurring_rules', i, r.template),
  );
  tables.recurring_occurrences.forEach((r, i) => {
    ref('recurring_occurrences', i, 'rule_id', 'recurring_rules', r.rule_id);
    ref(
      'recurring_occurrences',
      i,
      'transaction_id',
      'transactions',
      r.transaction_id,
    );
    if (!idSchema.safeParse(r.source_rule_id).success)
      issue(
        'recurring_occurrences',
        i,
        'source_rule_id',
        'invalid_source_rule',
      );
    else if (!has('recurring_rules', r.source_rule_id))
      history.deleted_rule_occurrences++;
    if (r.status === 'posted' && r.transaction_id === null)
      history.posted_without_transaction++;
    templateRefs('recurring_occurrences', i, r.template);
  });
  tables.budgets.forEach((r, i) =>
    ref('budgets', i, 'item_id', 'items', r.item_id),
  );
  for (const table of ['credit_card_settings', 'loan_settings'] as const)
    tables[table].forEach((r, i) => {
      ref(table, i, 'item_id', 'items', r.item_id);
      ref(table, i, 'payment_account_id', 'items', r.payment_account_id);
      for (const field of [
        'item_id',
        'payment_account_id',
        'interest_item_id',
      ] as const) {
        const key =
          field in r
            ? (r as unknown as Record<string, string | null>)[field]
            : null;
        const target = key
          ? tables.items.find((i) => i.id.toLowerCase() === key.toLowerCase())
          : null;
        if (
          target &&
          target.currency !== backup.ledger.base_currency &&
          (table === 'loan_settings' ||
            (field === 'payment_account_id' &&
              target.currency !==
                tables.items.find(
                  (x) => x.id.toLowerCase() === r.item_id.toLowerCase(),
                )?.currency))
        )
          issue(table, i, field, 'currency_not_supported');
      }

      if ('interest_item_id' in r)
        ref(table, i, 'interest_item_id', 'items', r.interest_item_id);
    });
  tables.securities.forEach((r, i) =>
    ref('securities', i, 'item_id', 'items', r.item_id),
  );
  tables.security_trades.forEach((r, i) => {
    ref('security_trades', i, 'security_id', 'securities', r.security_id);
    ref(
      'security_trades',
      i,
      'transaction_id',
      'transactions',
      r.transaction_id,
    );
    for (const field of [
      'settlement_item_id',
      'expense_item_id',
      'gain_item_id',
    ] as const)
      ref('security_trades', i, field, 'items', r[field]);
  });
  tables.income_codes.forEach((r, i) =>
    ref('income_codes', i, 'income_item_id', 'items', r.income_item_id),
  );
  tables.dividends.forEach((r, i) => {
    ref('dividends', i, 'security_id', 'securities', r.security_id);
    ref('dividends', i, 'transaction_id', 'transactions', r.transaction_id);
    ref('dividends', i, 'stock_trade_id', 'security_trades', r.stock_trade_id);
    for (const field of [
      'settlement_item_id',
      'default_income_item_id',
      'tax_item_id',
      'expense_item_id',
    ] as const)
      ref('dividends', i, field, 'items', r[field]);
  });
  tables.dividend_components.forEach((r, i) => {
    ref('dividend_components', i, 'dividend_id', 'dividends', r.dividend_id);
    ref('dividend_components', i, 'income_item_id', 'items', r.income_item_id);
  });
  tables.fixed_deposits.forEach((r, i) => {
    for (const field of [
      'item_id',
      'payout_account_id',
      'interest_item_id',
    ] as const)
      ref('fixed_deposits', i, field, 'items', r[field]);
    ref(
      'fixed_deposits',
      i,
      'renewed_from_id',
      'fixed_deposits',
      r.renewed_from_id,
    );
  });
  tables.deposit_postings.forEach((r, i) => {
    ref('deposit_postings', i, 'deposit_id', 'fixed_deposits', r.deposit_id);
    ref(
      'deposit_postings',
      i,
      'renewed_deposit_id',
      'fixed_deposits',
      r.renewed_deposit_id,
    );
    ref(
      'deposit_postings',
      i,
      'transaction_id',
      'transactions',
      r.transaction_id,
    );
  });
  tables.transactions.forEach((r, i) => {
    if (r.source_system === 'deposit') {
      if (!r.source_id || !has('deposit_postings', r.source_id))
        issue('transactions', i, 'source_id', 'missing_deposit_posting');
    }

    ref('transactions', i, 'payee_id', 'payees', r.payee_id);
    ref('transactions', i, 'project_id', 'projects', r.project_id);
    if (r.source_system === 'recurring') {
      const source = recurringSource(r.source_id);
      if (!source)
        issue('transactions', i, 'source_id', 'invalid_recurring_source');
      else if (!has('recurring_rules', source.rule))
        history.deleted_rule_transactions++;
    }
    if (r.source_system === 'life2023-csv') {
      const match = /^([0-9a-fA-F-]{36}):([1-9]\d*)$/.exec(r.source_id ?? '');
      if (
        !match ||
        !idSchema.safeParse(match[1]).success ||
        !has('import_jobs', match[1]!.toLowerCase())
      )
        issue('transactions', i, 'source_id', 'source_job_missing');
    }
  });
  tables.transaction_entries.forEach((r, i) => {
    ref(
      'transaction_entries',
      i,
      'transaction_id',
      'transactions',
      r.transaction_id,
    );
    ref('transaction_entries', i, 'item_id', 'items', r.item_id);
  });
  const dangling: Record<string, number> = {
    items: 0,
    payees: 0,
    projects: 0,
    transactions: 0,
    exchange_rates: 0,
    securities: 0,
    security_trades: 0,
    fixed_deposits: 0,
  };
  const deleted: Record<string, number> = { ...dangling };
  tables.import_source_records.forEach((r, i) => {
    ref(
      'import_source_records',
      i,
      'import_job_id',
      'import_jobs',
      r.import_job_id,
    );
    if (r.target_id.startsWith('deleted:')) {
      deleted[r.target_table]!++;
      return;
    }
    const format =
      r.target_table === 'exchange_rates'
        ? exchangeTargetPattern.test(r.target_id)
        : idSchema.safeParse(r.target_id).success;
    if (!format) {
      issue('import_source_records', i, 'target_id', 'invalid_target_format');
      return;
    }
    const key =
      r.target_table === 'exchange_rates'
        ? r.target_id
        : r.target_id.toLowerCase();
    if (!has(r.target_table, key)) dangling[r.target_table]!++;
  });
  // Parent links are a single-parent graph. Kahn traversal detects cycles without recursion.
  const children = new Map<string, string[]>(),
    pending = new Set(tables.items.map((i) => i.id.toLowerCase())),
    queue: string[] = [];
  for (const item of tables.items) {
    const id = item.id.toLowerCase(),
      parent = item.parent_id?.toLowerCase();
    if (parent && has('items', parent)) {
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    } else queue.push(id);
  }
  for (let n = 0; n < queue.length; n++) {
    const id = queue[n]!;
    if (!pending.delete(id)) continue;
    for (const child of children.get(id) ?? []) queue.push(child);
  }
  tables.items.forEach((r, i) => {
    if (pending.has(r.id.toLowerCase()))
      issue('items', i, 'parent_id', 'cycle');
  });
  if (issueCount) throw new BackupReferenceError(issues, issueCount);
  return { dangling, deleted, history };
}
export function defaultRestoreName(name: string, now = new Date()) {
  const time = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const suffix = `（還原 ${time}）`,
    prefix = Array.from(name);
  while (prefix.join('').length + suffix.length > 200) prefix.pop();
  return prefix.join('') + suffix;
}

export function recurringSource(value: string | null) {
  const m = /^([0-9a-fA-F-]{36}):(\d{4}-\d{2}-\d{2})$/.exec(value ?? '');
  return m &&
    idSchema.safeParse(m[1]).success &&
    dateSchema.safeParse(m[2]).success &&
    !m[2]!.startsWith('0000')
    ? { rule: m[1]!.toLowerCase(), date: m[2]! }
    : null;
}
