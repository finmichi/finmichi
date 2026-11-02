// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, migrate } from './index.js';
it('0012 tags only dangling provenance once, preserving live targets, IDs and malformed legacy data', async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error('TEST_DATABASE_URL required');
  const db = connect(process.env.TEST_DATABASE_URL),
    schema = 'provenance_' + randomUUID().replaceAll('-', ''),
    dir = await mkdtemp(join(tmpdir(), 'life-provenance-'));
  await db`CREATE SCHEMA ${db(schema)}`;
  const sql = postgres(process.env.TEST_DATABASE_URL, {
    max: 1,
    connection: { search_path: schema + ',public' },
    onnotice: () => {},
  });
  try {
    const migrations = fileURLToPath(
      new URL('../migrations/', import.meta.url),
    );
    for (const name of (await readdir(migrations)).filter(
      (n) => /^\d{4}_.*\.sql$/.test(n) && n < '0012_',
    ))
      await writeFile(join(dir, name), await readFile(join(migrations, name)));
    await migrate(sql, dir);
    const [user] =
      await sql`INSERT INTO users(oidc_issuer,oidc_subject) VALUES ('https://provenance.synthetic.invalid','synthetic') RETURNING id`;
    const [ledger] =
      await sql`INSERT INTO ledgers(owner_id,name) VALUES (${user!.id},'Synthetic provenance migration') RETURNING id`;
    const [item] =
      await sql`INSERT INTO items(ledger_id,kind,name,currency) VALUES (${ledger!.id},'asset','Synthetic live item','TWD') RETURNING id`;
    await sql`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES (${ledger!.id},'2026-10-17','USD','TWD',32.5)`;
    const [job] =
      await sql`INSERT INTO import_jobs(ledger_id,source_sha256,source_system,status) VALUES (${ledger!.id},${'0'.repeat(64)},'synthetic','imported') RETURNING id`;
    const cases = [
      ['live-item', 'items', String(item!.id), false],
      ['live-rate', 'exchange_rates', '2026-10-17|USD|TWD', false],
      ['missing-rate', 'exchange_rates', '2026-10-18|USD|TWD', true],
      ...(['items', 'payees', 'projects', 'transactions'] as const).map(
        (table) => ['missing-' + table, table, randomUUID(), true],
      ),
      ['deleted', 'transactions', 'deleted:' + randomUUID(), false],
      ['malformed', 'transactions', 'not-a-uuid', false],
    ] as [string, string, string, boolean][];
    const rows = [];
    for (const [key, table, target] of cases) {
      const [row] =
        await sql`INSERT INTO import_source_records(ledger_id,import_job_id,source_table,source_key,target_table,target_id) VALUES (${ledger!.id},${job!.id},'synthetic',${key},${table},${target}) RETURNING id,source_key,target_id`;
      rows.push(row!);
    }
    await migrate(sql);
    await migrate(sql);
    const after =
      await sql`SELECT id,source_key,target_id FROM import_source_records ORDER BY source_key`;
    expect(after).toHaveLength(cases.length);
    for (const [key, , target, changed] of cases) {
      const r = after.find((r) => r.source_key === key)!;
      expect(r.id).toBe(rows.find((r) => r.source_key === key)!.id);
      expect(r.target_id).toBe(changed ? 'deleted:' + target : target);
    }
    expect(
      await sql`SELECT name FROM schema_migrations WHERE name='0012_provenance_deleted_targets.sql'`,
    ).toHaveLength(1);
  } finally {
    await sql.end();
    await db`DROP SCHEMA ${db(schema)} CASCADE`;
    await db.end();
    await rm(dir, { recursive: true, force: true });
  }
});
