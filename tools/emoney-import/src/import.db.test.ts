// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect, migrate } from '@finmichi/db';
import { backupService, reportService, moneyUnits } from '@finmichi/core';
import { restoreService } from '../../../packages/core/src/restores.js';
import { applyPlan } from './import.js';
import {
  reconcilePlan,
  reconcileDatabase,
  compareBaseline,
} from './reconcile.js';
import { transform, encodePlan } from './transform.js';
import { readBundle, sha256 } from './bundle.js';
import { mappingSchema } from './schema.js';
const db = connect(process.env.TEST_DATABASE_URL!),
  users: string[] = [];
const fixture = fileURLToPath(new URL('../fixtures/', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const plan = async () =>
  transform(await readBundle(fixture), mappingSchema.parse({}), null);
async function user() {
  const subject = 'synthetic-emoney-' + randomUUID();
  const [r] =
    await db`INSERT INTO users(oidc_issuer,oidc_subject) VALUES ('https://synthetic-emoney.invalid',${subject}) RETURNING id`;
  const id = String(r!.id);
  users.push(id);
  return { subject, id };
}
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error('TEST_DATABASE_URL required');
  await migrate(db);
});
afterAll(async () => {
  for (const id of users) {
    await db`DELETE FROM transactions WHERE ledger_id IN (SELECT id FROM ledgers WHERE owner_id=${id})`;
    await db`DELETE FROM ledgers WHERE owner_id=${id}`;
    await db`DELETE FROM users WHERE id=${id}`;
  }
  await db.end();
});
it('atomic import all source entries; direct SQL balances match independent expected totals/reconcile', async () => {
  const u = await user(),
    p = await plan(),
    r = await applyPlan(
      db,
      { ...p, mapping_sha256: 'a'.repeat(64) },
      {
        ownerSubject: u.subject,
        ledgerName: 'synthetic main',
      },
    ),
    actual = await reconcileDatabase(db, u.subject, 'synthetic main');
  expect(actual).toEqual(reconcilePlan(p));
  expect(actual).toMatchObject({
    transaction_count: 12,
    total_assets: '44630.370000',
    total_liabilities: '3000.000000',
    net_worth: '41630.370000',
    fx_rounding_count: 1,
    fx_rounding_total: '-0.370000',
    opening_balance_count: 3,
  });
  const sums =
    await db`SELECT t.source_id,sum(e.base_amount)::text total,count(*)::int n FROM transactions t JOIN transaction_entries e ON e.transaction_id=t.id WHERE t.ledger_id=${r.ledger_id} GROUP BY t.id`;
  expect(sums).toHaveLength(12);
  for (const s of sums) {
    expect(moneyUnits(String(s.total))).toBe(0n);
    expect(s.n).toBeGreaterThanOrEqual(2);
  }
  for (const transaction of p.transactions) {
    const rows =
      await db`SELECT e.amount::text,e.currency,e.exchange_rate::text,e.base_amount::text,e.entry_position,i.name FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id JOIN items i ON i.id=e.item_id WHERE t.ledger_id=${r.ledger_id} AND t.source_id=${transaction.source_key} ORDER BY e.entry_position`;
    expect(rows).toHaveLength(transaction.entries.length);
    rows.forEach((e, i) => {
      const expected = transaction.entries[i]!;
      expect(moneyUnits(String(e.amount))).toBe(moneyUnits(expected.amount));
      expect(moneyUnits(String(e.base_amount))).toBe(
        moneyUnits(expected.base_amount),
      );
      expect(e.currency).toBe(expected.currency);
      expect(e.entry_position).toBe(i);
    });
  }
  const [provenance] =
    await db`SELECT count(*)::int n FROM import_source_records WHERE ledger_id=${r.ledger_id} AND source_key LIKE '%fx_rounding_residual'`;
  expect(provenance!.n).toBe(1);
  const [job] =
    await db`SELECT status,report FROM import_jobs WHERE id=${r.import_job_id}`;
  expect(job!.status).toBe('imported');
  expect(job!.report).toMatchObject({
    mapping_sha256: 'a'.repeat(64),
    allow_duplicate_ledger: false,
    parsed_only_counts: { REGULAR_DATA: 1, STOCK_DATA: 1 },
  });
  const audits =
    await db`SELECT action,outcome FROM audit_logs WHERE user_id=${u.id}`;
  expect(audits).toContainEqual({
    action: 'emoney.import',
    outcome: 'success',
  });
});
it('opening-day balance sheet and final net-worth identity are independently correct', async () => {
  const u = await user(),
    r = await applyPlan(db, await plan(), {
      ownerSubject: u.subject,
      ledgerName: 'opening',
    });
  const opening = await reportService(db).balance(u.id, r.ledger_id, {
    as_of: '2026-01-01',
  });
  expect(opening.totals).toMatchObject({
    assets: '13200.00',
    liabilities: '3000.00',
    net_worth: '10200.00',
    is_balanced: true,
  });
  const end = await reportService(db).balance(u.id, r.ledger_id, {
    as_of: '2026-12-31',
  });
  expect(end.totals).toMatchObject({
    assets: '44630.37',
    liabilities: '3000.00',
    net_worth: '41630.37',
    is_balanced: true,
  });
});
it('owner-wide duplicate, explicit override and different SHA each create separate new ledgers', async () => {
  const u = await user(),
    p = await plan(),
    opts = { ownerSubject: u.subject, ledgerName: 'first' };
  await applyPlan(db, p, opts);
  await expect(
    applyPlan(db, p, { ...opts, ledgerName: 'second' }),
  ).rejects.toMatchObject({
    code: 'already_imported_for_owner',
    details: { ledger_names: ['first'] },
  });
  await applyPlan(db, p, {
    ...opts,
    ledgerName: 'second',
    allowDuplicateLedger: true,
  });
  p.source_sha256 = sha256('different synthetic source');
  await applyPlan(db, p, { ...opts, ledgerName: 'third' });
  expect(await db`SELECT id FROM ledgers WHERE owner_id=${u.id}`).toHaveLength(
    3,
  );
});
it('restored job retains owner-wide dedup and emoney external source keys remain exact', async () => {
  const u = await user(),
    r = await applyPlan(db, await plan(), {
      ownerSubject: u.subject,
      ledgerName: 'source',
    }),
    backup = await backupService(db).download(u.id, r.ledger_id);
  const restored = await restoreService(db).confirm(u.id, backup, {
    name: 'restored',
  });
  await db`DELETE FROM transactions WHERE ledger_id=${r.ledger_id}`;
  await db`DELETE FROM ledgers WHERE id=${r.ledger_id}`;
  await expect(
    applyPlan(db, await plan(), {
      ownerSubject: u.subject,
      ledgerName: 'again',
    }),
  ).rejects.toMatchObject({
    code: 'already_imported_for_owner',
    details: { ledger_names: ['restored'] },
  });
  const keys =
    await db`SELECT source_id FROM transactions WHERE ledger_id=${restored.ledger.id} ORDER BY source_id`;
  expect(keys.map((r) => r.source_id).sort()).toEqual(
    backup.tables.transactions.map((t) => t.source_id).sort(),
  );
});
it('mid-write DB constraint failure rolls back ledger/job/items/entries and leaves triggers enabled', async () => {
  const u = await user(),
    p = await plan();
  p.transactions[5]!.entries[0]!.currency = 'JPY';
  await expect(
    applyPlan(db, p, { ownerSubject: u.subject, ledgerName: 'must rollback' }),
  ).rejects.toMatchObject({ code: '23503' });
  expect(await db`SELECT id FROM ledgers WHERE owner_id=${u.id}`).toHaveLength(
    0,
  );
  expect(
    await db`SELECT j.id FROM import_jobs j JOIN ledgers l ON j.ledger_id=l.id WHERE l.owner_id=${u.id}`,
  ).toHaveLength(0);
  const triggers =
    await db`SELECT tgenabled FROM pg_trigger WHERE tgname IN ('entries_balanced','transactions_balanced')`;
  expect(triggers).toHaveLength(2);
  expect(triggers.every((t) => t.tgenabled === 'O')).toBe(true);
});
it('non-numeric fatal report refuses apply without any ledger created', async () => {
  const u = await user(),
    b = await readBundle(fixture);
  b.tables.get('MYMONEY_DATA')![0]!.IN_MOUNT = 'not a number';
  const p = transform(b, mappingSchema.parse({}), null);
  await expect(
    applyPlan(db, p, { ownerSubject: u.subject, ledgerName: 'bad amount' }),
  ).rejects.toMatchObject({ code: 'import_has_errors' });
  expect(await db`SELECT id FROM ledgers WHERE owner_id=${u.id}`).toHaveLength(
    0,
  );
});
it('existing ledger name and any ledger_id option are rejected without modifying existing content', async () => {
  const u = await user();
  const [r] =
    await db`INSERT INTO ledgers(owner_id,name) VALUES (${u.id},'existing') RETURNING id`;
  await expect(
    applyPlan(db, await plan(), {
      ownerSubject: u.subject,
      ledgerName: 'existing',
    }),
  ).rejects.toMatchObject({ code: 'duplicate_ledger_name' });
  await expect(
    applyPlan(db, await plan(), {
      ownerSubject: u.subject,
      ledgerName: 'new',
      ledger_id: r!.id,
    } as never),
  ).rejects.toThrow();
  expect(await db`SELECT id FROM items WHERE ledger_id=${r!.id}`).toHaveLength(
    0,
  );
});
it('different users can import same SHA; read isolation and ambiguous/missing subject fail closed', async () => {
  const u = await user(),
    v = await user();
  await applyPlan(db, await plan(), {
    ownerSubject: u.subject,
    ledgerName: 'private',
  });
  await applyPlan(db, await plan(), {
    ownerSubject: v.subject,
    ledgerName: 'other',
  });
  await expect(
    reconcileDatabase(db, v.subject, 'private'),
  ).rejects.toMatchObject({ code: 'not_found' });
  await expect(
    applyPlan(db, await plan(), {
      ownerSubject: 'not-existing',
      ledgerName: 'new',
    }),
  ).rejects.toMatchObject({ code: 'owner_not_found' });
  const [r] =
    await db`INSERT INTO users(oidc_issuer,oidc_subject) VALUES ('https://other.invalid',${u.subject}) RETURNING id`;
  users.push(String(r!.id));
  await expect(
    reconcileDatabase(db, u.subject, 'private'),
  ).rejects.toMatchObject({ code: 'owner_subject_ambiguous' });
});
it('concurrent applies serialize per owner and only one succeeds', async () => {
  const u = await user(),
    p = await plan();
  const results = await Promise.allSettled([
    applyPlan(db, p, { ownerSubject: u.subject, ledgerName: 'race1' }),
    applyPlan(db, p, { ownerSubject: u.subject, ledgerName: 'race2' }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(
    (r) => r.status === 'rejected',
  ) as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: 'already_imported_for_owner' });
  expect(await db`SELECT id FROM ledgers WHERE owner_id=${u.id}`).toHaveLength(
    1,
  );
});
it('baseline compares every selected field/account with exact decimal equality and clear diffs', async () => {
  const p = reconcilePlan(await plan());
  expect(compareBaseline(p, p)).toMatchObject({
    matches: true,
    differences: [],
  });
  const expected = structuredClone(p);
  expected.transaction_count++;
  expected.balances[0]!.amount = '999';
  expected.total_assets = '0';
  const diff = compareBaseline(p, expected);
  expect(diff.matches).toBe(false);
  expect(diff.differences.map((d) => d.path)).toContain('transaction_count');
  expect(diff.differences).toHaveLength(3);
  expect(compareBaseline(p, { total_assets: '44630.37' }).matches).toBe(true);
  expect(() => compareBaseline(p, { typo: '1' })).toThrow();
});
it('actual CLI defaults dry-run with invalid DATABASE_URL; apply creates new ledger; reconcile baseline exit2', async () => {
  const u = await user(),
    dir = await mkdtemp(join(tmpdir(), 'emoney-cli-'));
  try {
    const dataset = join(dir, 'dataset.json'),
      out = join(dir, 'report.json');
    await writeFile(dataset, encodePlan(await plan()));
    const run = (args: string[], url = 'unreachable') =>
      spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: url },
      });
    const dry = run(['import', '--input', dataset, '--out', out]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8')).dry_run).toBe(true);
    expect(
      await db`SELECT id FROM ledgers WHERE owner_id=${u.id}`,
    ).toHaveLength(0);
    const rejected = run([
      'import',
      '--input',
      dataset,
      '--out',
      out,
      '--apply',
    ]);
    expect(rejected.status).toBe(1);
    const applied = run(
      [
        'import',
        '--input',
        dataset,
        '--out',
        out,
        '--apply',
        '--owner-subject',
        u.subject,
        '--ledger-name',
        'cli',
      ],
      process.env.TEST_DATABASE_URL,
    );
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8')).imported_count).toBe(12);
    const baseline = join(dir, 'baseline.json');
    await writeFile(baseline, JSON.stringify({ transaction_count: 999 }));
    const rec = run(
      [
        'reconcile',
        '--out',
        out,
        '--owner-subject',
        u.subject,
        '--ledger-name',
        'cli',
        '--baseline',
        baseline,
      ],
      process.env.TEST_DATABASE_URL,
    );
    expect(rec.status, rec.stderr).toBe(2);
    expect(
      JSON.parse(await readFile(out, 'utf8')).comparison.differences[0].path,
    ).toBe('transaction_count');
    const data = JSON.parse(await readFile(dataset, 'utf8'));
    data.plan.transactions[0].entries[0].amount = '55';
    await writeFile(dataset, JSON.stringify(data));
    expect(run(['import', '--input', dataset, '--out', out]).status).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('ADR8 rev1.2 base-reference warning and raw staging warnings persist without blocking atomic apply', async () => {
  const u = await user(),
    b = await readBundle(fixture);
  b.tables.set('MYMONEY_DATA', [
    {
      DATA_KEY: 'rev12',
      DATA_DATE: '2026/01/02',
      ITEM_CLASS: '資產',
      ITEM_NOTE: '美元帳戶',
      IN_MOUNT: '0',
      OUT_MOUNT: '100',
      EXCHANGE: '0.21',
    },
    {
      DATA_KEY: 'rev12',
      DATA_DATE: '2026/01/02',
      ITEM_CLASS: '支出',
      ITEM_NOTE: '餐費',
      IN_MOUNT: '21',
      OUT_MOUNT: '0',
      EXCHANGE: '0.21',
    },
  ]);
  b.tables.get('STOCK_DATA')![0]!.INOUT_PRICE = '1.234567';
  b.tables.get('STOCK_DATA')![0]!.INOUT_DATE = 'invalid-date';
  b.tables.get('REGULAR_DATA')![0]!.CURRENCY_NOTE = '合成未知幣別';
  const p = transform(b, mappingSchema.parse({}), null);
  expect(p.report.errors).toEqual([]);
  const r = await applyPlan(db, p, {
    ownerSubject: u.subject,
    ledgerName: 'rev12 warnings',
  });
  const [job] =
    await db`SELECT report FROM import_jobs WHERE id=${r.import_job_id}`;
  expect(job!.report.warning_counts).toMatchObject({
    source_rate_ignored_base_leg: 1,
    staging_precision_exceeds_supported: 1,
    staging_invalid_date: 1,
    staging_unknown_currency: 1,
  });
  expect(job!.report.staging.STOCK_DATA[0]).toMatchObject({
    INOUT_PRICE: '1.234567',
    INOUT_DATE: 'invalid-date',
  });
  expect(job!.report.staging.REGULAR_DATA[0].CURRENCY_NOTE).toBe(
    '合成未知幣別',
  );
  const entries =
    await db`SELECT e.amount::text,e.exchange_rate::text,e.base_amount::text FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id WHERE t.ledger_id=${r.ledger_id} AND t.source_id='rev12' ORDER BY entry_position`;
  expect(entries.map((e) => e.exchange_rate)).toEqual([
    '0.2100000000',
    '1.0000000000',
  ]);
  expect(entries.map((e) => moneyUnits(String(e.base_amount)))).toEqual([
    -21000000n,
    21000000n,
  ]);
  expect(await reconcileDatabase(db, u.subject, 'rev12 warnings')).toEqual(
    reconcilePlan(p),
  );
});
it('ADR8 rev1.2 actual --apply accepts raw P3 parse warnings and foreign rate one', async () => {
  const u = await user(),
    b = await readBundle(fixture),
    dir = await mkdtemp(join(tmpdir(), 'emoney-rev12-'));
  try {
    b.tables.get('REGULAR_DATA')![0]!.CURRENCY_NOTE = '合成未知幣別';
    b.tables.get('REGULAR_DATA')![0]!.SAVE_MOUNT = 'not-money';
    b.tables.get('STOCK_ID_DATA')![0]!.NOW_PRICE = '1.12345678901234567890';
    b.tables.set('OTHER_P3_TABLE', [
      { AMOUNT: 'NaN', VALUE: '0.12345678901234567890' },
    ]);
    b.tables.set('MYMONEY_DATA', [
      {
        DATA_KEY: 'one',
        DATA_DATE: '2026/01/02',
        ITEM_CLASS: '資產',
        ITEM_NOTE: '美元帳戶',
        IN_MOUNT: '0',
        OUT_MOUNT: '1',
        EXCHANGE: '1',
      },
      {
        DATA_KEY: 'one',
        DATA_DATE: '2026/01/02',
        ITEM_CLASS: '支出',
        ITEM_NOTE: '餐費',
        IN_MOUNT: '1',
        OUT_MOUNT: '0',
        EXCHANGE: '1',
      },
    ]);
    const p = transform(b, mappingSchema.parse({}), null),
      dataset = join(dir, 'dataset.json'),
      out = join(dir, 'result.json');
    expect(p.report.errors).toEqual([]);
    await writeFile(dataset, encodePlan(p));
    const command = spawnSync(
      process.execPath,
      [
        cli,
        'import',
        '--input',
        dataset,
        '--out',
        out,
        '--apply',
        '--owner-subject',
        u.subject,
        '--ledger-name',
        'rev12 cli',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL! },
      },
    );
    expect(command.status, command.stderr).toBe(0);
    const result = JSON.parse(await readFile(out, 'utf8')),
      [job] =
        await db`SELECT report FROM import_jobs WHERE id=${result.import_job_id}`;
    expect(job!.report.warning_counts.foreign_leg_rate_one).toBe(1);
    expect(job!.report.staging.STOCK_ID_DATA[0].NOW_PRICE).toBe(
      '1.12345678901234567890',
    );
    expect(job!.report.staging.OTHER_P3_TABLE[0]).toEqual({
      AMOUNT: 'NaN',
      VALUE: '0.12345678901234567890',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('ADR8 rev1.2 staging warnings never launder a booked nonnumeric amount into apply', async () => {
  const u = await user(),
    b = await readBundle(fixture);
  b.tables.get('REGULAR_DATA')![0]!.CURRENCY_NOTE = '合成未知幣別';
  b.tables.get('MYMONEY_DATA')![0]!.IN_MOUNT = 'NaN';
  const p = transform(b, mappingSchema.parse({}), null);
  expect(p.report.warning_counts.staging_unknown_currency).toBe(1);
  expect(p.report.errors).toContainEqual(
    expect.objectContaining({ table: 'MYMONEY_DATA', code: 'invalid_amount' }),
  );
  await expect(
    applyPlan(db, p, { ownerSubject: u.subject, ledgerName: 'must reject' }),
  ).rejects.toMatchObject({ code: 'import_has_errors' });
  expect(await db`SELECT id FROM ledgers WHERE owner_id=${u.id}`).toHaveLength(
    0,
  );
});

it('ADR8 §7.3: shared account IDs apply with distinct pair-based opening source_id and provenance', async () => {
  const b = await readBundle(fixture);
  for (const row of b.tables.get('ITEM_DATA')!) {
    row.ACCOUNT_ID = 'shared-synthetic';
    row.MAKE_NO = 'shared-synthetic';
  }
  const p = transform(b, mappingSchema.parse({}), null);
  expect(p.report.errors).toEqual([]);
  const u = await user();
  const result = await applyPlan(db, p, {
    ownerSubject: u.subject,
    ledgerName: 'shared opening ids',
  });
  const rows =
    await db`SELECT t.source_system,t.source_id,r.source_key FROM transactions t JOIN import_source_records r ON r.target_id=t.id::text AND r.target_table='transactions' AND r.source_table='ITEM_DATA' WHERE t.ledger_id=${result.ledger_id} ORDER BY t.source_id`;
  const expected = p.transactions
    .filter((t) => t.source_key.endsWith(':opening'))
    .map((t) => t.source_key)
    .sort();
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.source_id)).toEqual(expected);
  expect(rows.map((r) => r.source_key)).toEqual(expected);
  expect(rows.every((r) => r.source_system === 'emoney-mdb')).toBe(true);
  expect(await reconcileDatabase(db, u.subject, 'shared opening ids')).toEqual(
    reconcilePlan(p),
  );
});

it('ADR8 §8.3: ambiguous base-resolved account is fatal and apply leaves no ledger', async () => {
  const b = await readBundle(fixture);
  const row = b.tables.get('ITEM_DATA')![0]!;
  row.EXCHANGE_NOTE = '';
  row.EXCHANGE = '0.21';
  const p = transform(b, mappingSchema.parse({}), null);
  expect(p.report.errors).toContainEqual(
    expect.objectContaining({
      code: 'ambiguous_item_currency',
      key: JSON.stringify([row.ITEM_CLASS, row.ITEM_NOTE]),
      count: 1,
    }),
  );
  const u = await user();
  await expect(
    applyPlan(db, p, {
      ownerSubject: u.subject,
      ledgerName: 'ambiguous rejected',
    }),
  ).rejects.toMatchObject({ code: 'import_has_errors' });
  expect(await db`SELECT id FROM ledgers WHERE owner_id=${u.id}`).toHaveLength(
    0,
  );
});
it('ADR8 §8.3: exact JPY/TWD mappings apply atomically with chosen currency, warnings and mapping SHA persisted', async () => {
  for (const currency of ['JPY', 'TWD']) {
    const b = await readBundle(fixture);
    b.tables.set('ITEM_DATA', [
      {
        ITEM_CLASS: '資產',
        ITEM_NOTE: '合成歧義帳戶',
        EXCHANGE_NOTE: '',
        EXCHANGE: '0.21',
        BEFORE_MOUNT: '100',
      },
      {
        ITEM_CLASS: '資產',
        ITEM_NOTE: '合成台幣帳戶',
        EXCHANGE_NOTE: '台幣',
        EXCHANGE: '1',
        BEFORE_MOUNT: '0',
      },
    ]);
    b.tables.set('MYMONEY_DATA', [
      {
        DATA_KEY: 'synthetic-currency',
        DATA_DATE: '2026/01/02',
        ITEM_CLASS: '資產',
        ITEM_NOTE: '合成歧義帳戶',
        IN_MOUNT: '0',
        OUT_MOUNT: '100',
        EXCHANGE: '0.21',
      },
      {
        DATA_KEY: 'synthetic-currency',
        DATA_DATE: '2026/01/02',
        ITEM_CLASS: '資產',
        ITEM_NOTE: '合成台幣帳戶',
        IN_MOUNT: currency === 'JPY' ? '21' : '100',
        OUT_MOUNT: '0',
        EXCHANGE: '1',
      },
    ]);
    const raw = JSON.stringify({
      item_currencies: [
        { item_class: '資產', item_note: '合成歧義帳戶', currency },
      ],
    });
    const mappingSha = sha256(raw),
      p = transform(b, mappingSchema.parse(JSON.parse(raw)), mappingSha);
    expect(p.report.errors).toEqual([]);
    expect(p.report.skipped).toEqual([]);
    const u = await user();
    const result = await applyPlan(db, p, {
      ownerSubject: u.subject,
      ledgerName: 'chosen ' + currency,
    });
    const rows =
      await db`SELECT e.currency,e.exchange_rate::text,e.base_amount::text FROM transaction_entries e JOIN items i ON i.id=e.item_id WHERE e.ledger_id=${result.ledger_id} AND i.name='合成歧義帳戶' ORDER BY e.amount DESC`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.currency)).toEqual([currency, currency]);
    expect(rows.map((r) => r.exchange_rate)).toEqual(
      currency === 'JPY'
        ? ['0.2100000000', '0.2100000000']
        : ['1.0000000000', '1.0000000000'],
    );
    expect(rows.map((r) => r.base_amount)).toEqual(
      currency === 'JPY'
        ? ['21.000000', '-21.000000']
        : ['100.000000', '-100.000000'],
    );
    const [job] =
      await db`SELECT report FROM import_jobs WHERE id=${result.import_job_id}`;
    expect(job!.report.mapping_sha256).toBe(mappingSha);
    expect(
      job!.report.warning_counts.item_rate_ignored_base_currency ?? 0,
    ).toBe(currency === 'TWD' ? 1 : 0);
    expect(
      await reconcileDatabase(db, u.subject, 'chosen ' + currency),
    ).toEqual(reconcilePlan(p));
  }
});
