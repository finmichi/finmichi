// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, migrate } from './index.js';
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'TEST_DATABASE_URL required; use an isolated synthetic test database',
  );
const db = connect(url);
beforeAll(async () => {
  await migrate(db);
});
afterAll(async () => {
  await db.end();
});
describe('real PostgreSQL migrations', () => {
  it('is idempotent and safe under concurrent runners', async () => {
    await Promise.all([migrate(db), migrate(db)]);
    const [r] =
      await db`SELECT count(*)::int AS count FROM schema_migrations WHERE name = '0001_init.sql'`;
    expect(r?.count).toBe(1);
  });
  it('rejects plaintext session tokens and checks FK', async () => {
    await expect(
      db`INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ('plaintext',gen_random_uuid(),now()+interval '7 days')`,
    ).rejects.toThrow();
  });
  it('rolls back a failing migration and rejects changed applied SQL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finmichi-migration-'));
    try {
      await writeFile(
        join(dir, '9999_failure.sql'),
        'CREATE TABLE migration_rollback_probe(id int); SELECT missing_function();',
      );
      await expect(migrate(db, dir)).rejects.toThrow();
      const [r] =
        await db`SELECT to_regclass('migration_rollback_probe') AS name`;
      expect(r?.name).toBe(null);
      await writeFile(join(dir, '0001_init.sql'), 'SELECT 1;');
      await expect(migrate(db, dir)).rejects.toThrow(
        'Applied migration changed',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
