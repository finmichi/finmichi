// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { Database, Transaction } from '@finmichi/db';
import {
  DomainError,
  ledgerService,
  mutation,
  ownedLedger,
  valid,
} from './catalog.js';
import {
  catalogQuerySchema,
  idSchema,
  namedCreateSchema,
  memoCreateSchema,
  memoUpdateSchema,
  namedUpdateSchema,
  type NamedRecord,
} from './catalog-schemas.js';
const tableSchema = z.enum(['payees', 'projects', 'memo_templates']);
export type NamedTable = z.infer<typeof tableSchema>;
export function namedRecordService(db: Database, resource: NamedTable) {
  // Runtime allowlist as well as TypeScript; caller input never becomes raw SQL.
  const table = valid(tableSchema, resource);
  async function record(sql: Transaction, ledger: string, id: string) {
    const [row] = await sql<
      NamedRecord[]
    >`SELECT * FROM ${sql(table)} WHERE ledger_id=${ledger} AND id=${id}`;
    if (!row) throw new DomainError('not_found', 404);
    return row;
  }
  return {
    async list(actor: string, ledgerId: unknown, query: unknown = {}) {
      const ledger = valid(idSchema, ledgerId),
        q = valid(catalogQuerySchema, query);
      await ledgerService(db).get(actor, ledger);
      return db<
        NamedRecord[]
      >`SELECT r.* FROM ${db(table)} r JOIN ledgers l ON l.id=r.ledger_id WHERE l.owner_id=${actor} AND r.ledger_id=${ledger} AND (${q.include_archived === 'true'} OR NOT r.archived) ORDER BY lower(r.name),r.id`;
    },
    async get(actor: string, ledgerId: unknown, recordId: unknown) {
      const ledger = valid(idSchema, ledgerId),
        id = valid(idSchema, recordId);
      await ledgerService(db).get(actor, ledger);
      const [row] = await db<
        NamedRecord[]
      >`SELECT r.* FROM ${db(table)} r JOIN ledgers l ON l.id=r.ledger_id WHERE l.owner_id=${actor} AND r.ledger_id=${ledger} AND r.id=${id}`;
      if (!row) throw new DomainError('not_found', 404);
      return row;
    },
    async create(actor: string, ledgerId: unknown, input: unknown) {
      return mutation(db, actor, `${table}.create`, async (sql) => {
        const ledger = valid(idSchema, ledgerId),
          data =
            table === 'memo_templates'
              ? valid(memoCreateSchema, input)
              : valid(namedCreateSchema, input);
        await ownedLedger(sql, actor, ledger);
        const [row] = await sql<
          NamedRecord[]
        >`INSERT INTO ${sql(table)} ${sql({ ...data, ledger_id: ledger })} RETURNING *`;
        return row!;
      });
    },
    async update(
      actor: string,
      ledgerId: unknown,
      recordId: unknown,
      input: unknown,
    ) {
      return mutation(db, actor, `${table}.update`, async (sql) => {
        const ledger = valid(idSchema, ledgerId),
          id = valid(idSchema, recordId),
          data =
            table === 'memo_templates'
              ? valid(memoUpdateSchema, input)
              : valid(namedUpdateSchema, input);
        await ownedLedger(sql, actor, ledger);
        await record(sql, ledger, id);
        const [row] = await sql<
          NamedRecord[]
        >`UPDATE ${sql(table)} SET ${sql(data)} WHERE ledger_id=${ledger} AND id=${id} RETURNING *`;
        return row!;
      });
    },
    async remove(actor: string, ledgerId: unknown, recordId: unknown) {
      return mutation(db, actor, `${table}.delete`, async (sql) => {
        const ledger = valid(idSchema, ledgerId),
          id = valid(idSchema, recordId);
        await ownedLedger(sql, actor, ledger);
        await record(sql, ledger, id);
        // Existing transaction FK prevents deleting referenced data; archive instead.
        await sql`DELETE FROM ${sql(table)} WHERE ledger_id=${ledger} AND id=${id}`;
      });
    },
  };
}
