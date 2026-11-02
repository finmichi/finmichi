// SPDX-License-Identifier: AGPL-3.0-only
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export const connect = (url: string) =>
  postgres(url, { max: 5, onnotice: () => {} });
export type Transaction = postgres.TransactionSql;
export type Database = ReturnType<typeof connect>;
export async function migrate(
  db: Database,
  directory = fileURLToPath(new URL('../migrations/', import.meta.url)),
) {
  await db.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(510051)`;
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
  });
  for (const name of (await readdir(directory))
    .filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n))
    .sort()) {
    const content = await readFile(`${directory}/${name}`, 'utf8');
    const checksum = createHash('sha256').update(content).digest('hex');
    await db.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(510051)`;
      const [applied] =
        await sql`SELECT checksum FROM schema_migrations WHERE name = ${name}`;
      if (applied) {
        if (applied.checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        return;
      }
      await sql.unsafe(content);
      await sql`INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${checksum})`;
    });
  }
}
export {
  operationalErrorCode,
  operationalErrorClass,
} from './operational-error.js';
