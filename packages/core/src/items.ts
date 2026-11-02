// SPDX-License-Identifier: AGPL-3.0-only
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
  itemCreateSchema,
  itemUpdateSchema,
  type Item,
} from './catalog-schemas.js';
async function item(sql: Transaction, ledger: string, id: string) {
  const [row] = await sql<
    Item[]
  >`SELECT * FROM items WHERE ledger_id=${ledger} AND id=${id}`;
  if (!row) throw new DomainError('not_found', 404);
  return row;
}
async function validateParent(
  sql: Transaction,
  ledger: string,
  parent: string | null,
  kind: Item['kind'],
) {
  if (parent !== null) {
    const row = await item(sql, ledger, parent);
    if (row.kind !== kind) throw new DomainError('parent_kind_mismatch', 400);
  }
}
export async function createItem(
  sql: Transaction,
  ledger: string,
  input: unknown,
) {
  const data = valid(itemCreateSchema, input);
  if (data.securities) {
    const [l] = await sql`SELECT base_currency FROM ledgers WHERE id=${ledger}`;
    if (l?.base_currency !== 'TWD')
      throw new DomainError('securities_require_twd_ledger', 400);
    if (data.kind !== 'asset' || data.currency !== 'TWD')
      throw new DomainError('security_item_invalid', 400);
  }
  await validateParent(sql, ledger, data.parent_id, data.kind);
  const [row] = await sql<
    Item[]
  >`INSERT INTO items ${sql({ ...data, ledger_id: ledger })} RETURNING *`;
  return row!;
}
export function itemService(db: Database) {
  return {
    async list(actor: string, ledgerId: unknown, query: unknown = {}) {
      const ledger = valid(idSchema, ledgerId),
        q = valid(catalogQuerySchema, query);
      await ledgerService(db).get(actor, ledger);
      return db<
        Item[]
      >`SELECT i.* FROM items i JOIN ledgers l ON l.id=i.ledger_id WHERE l.owner_id=${actor} AND i.ledger_id=${ledger} AND (${q.include_archived === 'true'} OR NOT i.archived) ORDER BY i.kind,lower(i.name),i.id`;
    },
    async get(actor: string, ledgerId: unknown, itemId: unknown) {
      const ledger = valid(idSchema, ledgerId),
        id = valid(idSchema, itemId);
      await ledgerService(db).get(actor, ledger);
      const [row] = await db<
        Item[]
      >`SELECT i.* FROM items i JOIN ledgers l ON l.id=i.ledger_id WHERE l.owner_id=${actor} AND i.ledger_id=${ledger} AND i.id=${id}`;
      if (!row) throw new DomainError('not_found', 404);
      return row;
    },
    async create(actor: string, ledgerId: unknown, input: unknown) {
      return mutation(db, actor, 'item.create', async (sql) => {
        const ledger = valid(idSchema, ledgerId),
          data = valid(itemCreateSchema, input);
        await ownedLedger(sql, actor, ledger);
        return createItem(sql, ledger, data);
      });
    },
    async update(
      actor: string,
      ledgerId: unknown,
      itemId: unknown,
      input: unknown,
    ) {
      return mutation(db, actor, 'item.update', async (sql) => {
        const ledger = valid(idSchema, ledgerId),
          id = valid(idSchema, itemId),
          data = valid(itemUpdateSchema, input);
        const l = await ownedLedger(sql, actor, ledger);
        if (data.securities && l.base_currency !== 'TWD')
          throw new DomainError('securities_require_twd_ledger', 400);
        const current = await item(sql, ledger, id);
        if (data.parent_id !== undefined)
          await validateParent(sql, ledger, data.parent_id, current.kind);
        // DB cycle trigger runs under the same ledger lock; concurrent opposite moves cannot form a cycle.
        const [row] = await sql<
          Item[]
        >`UPDATE items SET ${sql(data)} WHERE id=${id} AND ledger_id=${ledger} RETURNING *`;
        return row!;
      });
    },
  };
}
