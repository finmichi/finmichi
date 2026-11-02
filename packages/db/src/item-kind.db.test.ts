// SPDX-License-Identifier: AGPL-3.0-only
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, migrate } from './index.js';
if (!process.env.TEST_DATABASE_URL)
  throw new Error('TEST_DATABASE_URL required');
const db = connect(process.env.TEST_DATABASE_URL);
let ledger: string, asset: string, expense: string;
beforeAll(async () => {
  await migrate(db);
  const [u] =
    await db`INSERT INTO users(oidc_issuer,oidc_subject) VALUES ('https://kind-db.synthetic.invalid','synthetic') RETURNING id`;
  const [l] =
    await db`INSERT INTO ledgers(owner_id,name) VALUES (${u!.id},'Synthetic kind DB') RETURNING id`;
  ledger = String(l!.id);
  const rows =
    await db`INSERT INTO items(ledger_id,name,kind,currency) VALUES (${ledger},'Synthetic asset','asset','TWD'),(${ledger},'Synthetic expense','expense','TWD') RETURNING id,kind`;
  asset = String(rows.find((r) => r.kind === 'asset')!.id);
  expense = String(rows.find((r) => r.kind === 'expense')!.id);
});
afterAll(async () => {
  await db.end();
});
it('DB rejects cross-kind insert and move without service validation', async () => {
  await expect(
    db`INSERT INTO items(ledger_id,parent_id,name,kind,currency) VALUES (${ledger},${asset},'Synthetic rejected','expense','USD')`,
  ).rejects.toMatchObject({ code: '23514', message: 'parent_kind_mismatch' });
  const [row] =
    await db`INSERT INTO items(ledger_id,parent_id,name,kind,currency) VALUES (${ledger},${asset},'Synthetic movable','asset','TWD') RETURNING id`;
  await expect(
    db`UPDATE items SET parent_id=${expense} WHERE id=${row!.id}`,
  ).rejects.toMatchObject({ code: '23514', message: 'parent_kind_mismatch' });
  const [unchanged] = await db`SELECT parent_id FROM items WHERE id=${row!.id}`;
  expect(unchanged!.parent_id).toBe(asset);
});
it('DB rejects a direct child kind change that disagrees with its parent', async () => {
  const [row] =
    await db`INSERT INTO items(ledger_id,parent_id,name,kind,currency) VALUES (${ledger},${asset},'Synthetic child kind','asset','TWD') RETURNING id`;
  await expect(
    db`UPDATE items SET kind='expense' WHERE id=${row!.id}`,
  ).rejects.toMatchObject({ code: '23514', message: 'parent_kind_mismatch' });
});
it('DB also rejects a direct parent kind change that would invalidate existing children', async () => {
  await db`INSERT INTO items(ledger_id,parent_id,name,kind,currency) VALUES (${ledger},${asset},'Synthetic parent defense child','asset','TWD')`;
  await expect(
    db`UPDATE items SET kind='expense' WHERE id=${asset}`,
  ).rejects.toMatchObject({ code: '23514', message: 'parent_kind_mismatch' });
  const [parent] = await db`SELECT kind FROM items WHERE id=${asset}`;
  expect(parent!.kind).toBe('asset');
});
it('DB allows same-kind parents with different currency, and moves to root', async () => {
  const [row] =
    await db`INSERT INTO items(ledger_id,parent_id,name,kind,currency) VALUES (${ledger},${asset},'Synthetic USD child','asset','USD') RETURNING id,currency,parent_id`;
  expect(row).toMatchObject({ currency: 'USD', parent_id: asset });
  await db`UPDATE items SET parent_id=NULL WHERE id=${row!.id}`;
  await db`UPDATE items SET parent_id=${asset} WHERE id=${row!.id}`;
});
it('serializes a concurrent parent kind change and child insert', async () => {
  const [p] =
    await db`INSERT INTO items(ledger_id,name,kind,currency) VALUES (${ledger},'Synthetic concurrent parent','asset','TWD') RETURNING id`;
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const changing = db.begin(async (sql) => {
    await sql`UPDATE items SET kind='expense' WHERE id=${p!.id}`;
    ready();
    await barrier;
  });
  await started;
  const inserting =
    db`INSERT INTO items(ledger_id,parent_id,name,kind,currency) VALUES (${ledger},${p!.id},'Synthetic concurrent child','asset','USD')`.execute();
  // Attach rejection handler before releasing the writer; assert after both settle.
  const settled = Promise.allSettled([changing, inserting]);
  release();
  const results = await settled;
  expect(results[0]!.status).toBe('fulfilled');
  expect(results[1]).toMatchObject({
    status: 'rejected',
    reason: { code: '23514', message: 'parent_kind_mismatch' },
  });
});
it('migration fails on pre-existing invalid data and rolls back, then succeeds after explicit synthetic repair', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'life-kind-migrations-'));
  const schema = 'kind_preflight_' + randomUUID().replaceAll('-', '');
  await db`CREATE SCHEMA ${db(schema)}`;
  const scoped = postgres(process.env.TEST_DATABASE_URL!, {
    max: 1,
    connection: { search_path: schema + ',public' },
    onnotice: () => {},
  });
  try {
    const [scope] = await scoped`SELECT current_schema() AS name`;
    expect(scope!.name).toBe(schema);
    const migrations = fileURLToPath(
      new URL('../migrations/', import.meta.url),
    );
    for (const name of (await readdir(migrations)).filter((n) =>
      /^000[1-4]_.*\.sql$/.test(n),
    ))
      await writeFile(join(dir, name), await readFile(join(migrations, name)));
    await migrate(scoped, dir);
    const [u] =
      await scoped`INSERT INTO users(oidc_issuer,oidc_subject) VALUES ('https://preflight.synthetic.invalid','synthetic') RETURNING id`;
    const [l] =
      await scoped`INSERT INTO ledgers(owner_id,name) VALUES (${u!.id},'Synthetic preflight') RETURNING id`;
    const [p] =
      await scoped`INSERT INTO items(ledger_id,name,kind,currency) VALUES (${l!.id},'Synthetic preflight parent','asset','TWD') RETURNING id`;
    const [c] =
      await scoped`INSERT INTO items(ledger_id,parent_id,name,kind,currency) VALUES (${l!.id},${p!.id},'Synthetic invalid old child','expense','USD') RETURNING id`;
    await expect(migrate(scoped)).rejects.toThrow(
      'existing items violate parent_kind_mismatch',
    );
    expect(
      await scoped`SELECT name FROM schema_migrations WHERE name='0005_item_parent_kind.sql'`,
    ).toHaveLength(0);
    expect(
      await scoped`SELECT tgname FROM pg_trigger WHERE tgrelid='items'::regclass AND tgname='items_kind_consistent'`,
    ).toHaveLength(0);
    const [unchanged] = await scoped`SELECT kind FROM items WHERE id=${c!.id}`;
    expect(unchanged!.kind).toBe('expense');
    await scoped`UPDATE items SET kind='asset' WHERE id=${c!.id}`;
    await migrate(scoped);
    await migrate(scoped);
    expect(
      await scoped`SELECT name FROM schema_migrations WHERE name='0005_item_parent_kind.sql'`,
    ).toHaveLength(1);
    await expect(
      scoped`UPDATE items SET kind='expense' WHERE id=${p!.id}`,
    ).rejects.toMatchObject({ code: '23514', message: 'parent_kind_mismatch' });
  } finally {
    await scoped.end();
    await db`DROP SCHEMA IF EXISTS ${db(schema)} CASCADE`;
    await rm(dir, { recursive: true, force: true });
  }
});
