// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { validateBackup, defaultRestoreName } from './backup-validation.js';
import { backupPayloadSha256 } from './backups.js';
import {
  backupTableNames,
  BACKUP_MAX_TRANSACTIONS,
  type LedgerBackup,
} from './backup-schemas.js';
function empty(): LedgerBackup {
  const tables = {
    items: [],
    payees: [],
    projects: [],
    memo_templates: [],
    transactions: [],
    transaction_entries: [],
    exchange_rates: [],
    import_jobs: [],
    import_source_records: [],
    recurring_rules: [],
    recurring_occurrences: [],
    budgets: [],
    credit_card_settings: [],
    loan_settings: [],
    securities: [],
    security_trades: [],
    manual_prices: [],
    income_codes: [],
    dividends: [],
    dividend_components: [],
    fixed_deposits: [],
    deposit_postings: [],
    reminder_settings: [],
    reminder_reads: [],
  };
  return {
    format: 'finmichi',
    schemaVersion: 9,
    exportedAt: '2026-10-17T00:00:00Z',
    appVersion: 'synthetic',
    ledger: {
      id: randomUUID(),
      name: '合成',
      base_currency: 'TWD',
      locked_until: null,
      created_at: '2026-10-17T00:00:00Z',
    },
    tables,
    counts: Object.fromEntries(
      backupTableNames.map((k) => [k, 0]),
    ) as LedgerBackup['counts'],
    payloadSha256: backupPayloadSha256(tables),
  };
}
it('transaction cap rejects 200001 before expensive row validation', () => {
  const b = empty();
  const input = {
    ...b,
    tables: {
      ...b.tables,
      transactions: Array.from(
        { length: BACKUP_MAX_TRANSACTIONS + 1 },
        () => ({}),
      ),
    },
  };
  expect(() => validateBackup(input)).toThrow('backup_too_large');
});
it('UUID references are case-insensitive and malformed/deleted provenance has explicit treatment', () => {
  const b = empty(),
    id = randomUUID().toUpperCase();
  b.tables.items.push({
    id,
    ledger_id: b.ledger.id.toUpperCase(),
    parent_id: null,
    name: '合成資產',
    kind: 'asset',
    currency: 'TWD',
    non_operating: false,
    fixed: false,
    credit_card: false,
    loan: false,
    securities: false,
    archived: false,
  });
  b.counts.items = 1;
  b.payloadSha256 = backupPayloadSha256(b.tables);
  expect(validateBackup(b).dangling.items).toBe(0);
  const child = {
    ...b.tables.items[0]!,
    id: randomUUID(),
    parent_id: id.toLowerCase(),
    name: '合成子科目',
  };
  b.tables.items.push(child);
  b.counts.items = 2;
  b.payloadSha256 = backupPayloadSha256(b.tables);
  expect(() => validateBackup(b)).not.toThrow();
});
it('default restored name retains a valid Unicode prefix within 200 characters', () => {
  const name = defaultRestoreName(
    '😀'.repeat(100),
    new Date('2026-10-17T00:00:00Z'),
  );
  expect(name.length).toBeLessThanOrEqual(200);
  expect(name).toContain('（還原 2026-10-17 08:00）');
  expect(Array.from(name).some((c) => /^[\uD800-\uDFFF]$/.test(c))).toBe(false);
});
it('v1–v8 shapes validate original checksums before adding newer empty sections', () => {
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const b = empty();
    const input = JSON.parse(JSON.stringify(b));
    input.schemaVersion = version;
    input.format = 'life-ledger';
    for (const k of [
      ...(version < 7 ? ['reminder_settings', 'reminder_reads'] : []),
      ...(version < 6 ? ['fixed_deposits', 'deposit_postings'] : []),
      ...(version < 5
        ? ['income_codes', 'dividends', 'dividend_components']
        : []),
      ...(version < 4
        ? ['securities', 'security_trades', 'manual_prices']
        : []),
    ]) {
      delete input.tables[k];
      delete input.counts[k];
    }
    if (version < 3)
      for (const k of ['credit_card_settings', 'loan_settings']) {
        delete input.tables[k];
        delete input.counts[k];
      }
    if (version < 2)
      for (const k of ['recurring_rules', 'recurring_occurrences', 'budgets']) {
        delete input.tables[k];
        delete input.counts[k];
      }
    input.payloadSha256 = backupPayloadSha256(input.tables);
    const before = JSON.stringify(input);
    const result = validateBackup(input);
    expect(result.sourceVersion).toBe(version);
    expect(result.backup.schemaVersion).toBe(9);
    expect(result.backup.tables.securities).toEqual([]);
    expect(result.backup.tables.security_trades).toEqual([]);
    expect(result.backup.tables.manual_prices).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  }
});

it('rejects mismatched format/version pairs and unknown future schemas', () => {
  const b = empty();
  for (const bad of [
    { ...b, format: 'life-ledger' },
    { ...b, schemaVersion: 8 },
    { ...b, format: 'other' },
  ])
    expect(() => validateBackup(bad)).toThrow('invalid_backup');
  expect(() => validateBackup({ ...b, schemaVersion: 10 })).toThrow(
    'backup_schema_unsupported',
  );
});
