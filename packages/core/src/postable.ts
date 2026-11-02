// SPDX-License-Identifier: AGPL-3.0-only
import type { Transaction } from '@finmichi/db';
import { DomainError } from './catalog.js';

/** Call inside the owning ledger transaction. Historical unchanged fields survive. */
export async function assertPostableItem(
  sql: Transaction,
  ledger: string,
  id: string,
  unchanged = false,
) {
  if (unchanged) return;
  const [row] =
    await sql`SELECT archived, EXISTS(SELECT 1 FROM items child WHERE child.ledger_id=${ledger} AND child.parent_id=items.id AND NOT child.archived) AS parent FROM items WHERE ledger_id=${ledger} AND id=${id}`;
  if (!row) throw new DomainError('item_ledger_mismatch', 400);
  if (row.archived) throw new DomainError('archived_resource', 400);
  if (row.parent) throw new DomainError('parent_item_not_postable', 400);
}
