// SPDX-License-Identifier: AGPL-3.0-only
import { auditActionSchema, type AuditAction } from './audit-schemas.js';
import { z } from 'zod';
import { ledgerLockSchema, lockChange } from './ledger-lock.js';
import type { Database, Transaction } from '@finmichi/db';
import {
  idSchema,
  ledgerCreateSchema,
  ledgerUpdateSchema,
  type Ledger,
} from './catalog-schemas.js';
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}
export function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError('invalid_input', 400);
  return result.data;
}
export async function ownedLedger(
  sql: Transaction,
  actor: string,
  ledger: string,
  lock = true,
) {
  const [row] = await sql<
    Ledger[]
  >`SELECT id,name,base_currency,locked_until::text FROM ledgers WHERE id=${ledger} AND owner_id=${actor} ${lock ? sql`FOR UPDATE` : sql``}`;
  if (!row) throw new DomainError('not_found', 404);
  return row;
}
export async function mutation<T>(
  db: Database,
  actor: string,
  action: AuditAction | (() => AuditAction),
  operation: (sql: Transaction) => Promise<T>,
): Promise<T> {
  valid(idSchema, actor);
  const auditAction = () =>
    valid(auditActionSchema, typeof action === 'function' ? action() : action);
  auditAction();
  try {
    return (await db.begin(async (sql) => {
      const result = await operation(sql);
      await sql`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${actor},${auditAction()},'success')`;
      return result;
    })) as T;
  } catch (error) {
    if (error instanceof DomainError) {
      await db`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${actor},${auditAction()},${error.statusCode === 404 ? 'denied' : 'error'})`;
      throw error;
    }
    await db`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${actor},${auditAction()},'error')`;
    if (error && typeof error === 'object' && 'code' in error) {
      const mapped = (
        {
          '23505': ['duplicate_name', 409],
          '23503': ['in_use', 409],
          '23514': ['invalid_input', 400],
        } as const
      )[error.code as '23505'];
      if (mapped) throw new DomainError(mapped[0], mapped[1]);
    }
    throw error;
  }
}
async function assertEmpty(sql: Transaction, ledger: string) {
  const [r] = await sql`SELECT EXISTS (
    SELECT 1 FROM items WHERE ledger_id=${ledger} UNION ALL
    SELECT 1 FROM payees WHERE ledger_id=${ledger} UNION ALL
    SELECT 1 FROM projects WHERE ledger_id=${ledger} UNION ALL
    SELECT 1 FROM memo_templates WHERE ledger_id=${ledger} UNION ALL
    SELECT 1 FROM transactions WHERE ledger_id=${ledger} UNION ALL
    SELECT 1 FROM exchange_rates WHERE ledger_id=${ledger} UNION ALL
    SELECT 1 FROM import_jobs WHERE ledger_id=${ledger} UNION ALL
    SELECT 1 FROM income_codes WHERE ledger_id=${ledger}
  ) AS populated`;
  if (r!.populated) throw new DomainError('ledger_not_empty', 409);
}
export function ledgerService(db: Database) {
  return {
    async list(actor: string) {
      valid(idSchema, actor);
      return db<
        Ledger[]
      >`SELECT id,name,base_currency,locked_until::text FROM ledgers WHERE owner_id=${actor} ORDER BY created_at,id`;
    },
    async get(actor: string, id: unknown) {
      const ledger = valid(idSchema, id);
      valid(idSchema, actor);
      const [row] = await db<
        Ledger[]
      >`SELECT id,name,base_currency,locked_until::text FROM ledgers WHERE id=${ledger} AND owner_id=${actor}`;
      if (!row) throw new DomainError('not_found', 404);
      return row;
    },
    async create(actor: string, input: unknown) {
      return mutation(db, actor, 'ledger.create', async (sql) => {
        const data = valid(ledgerCreateSchema, input);
        const [row] = await sql<
          Ledger[]
        >`INSERT INTO ledgers(owner_id,name,base_currency) VALUES (${actor},${data.name},${data.base_currency}) RETURNING id,name,base_currency,locked_until::text`;
        return row!;
      });
    },
    async update(actor: string, id: unknown, input: unknown) {
      return mutation(db, actor, 'ledger.update', async (sql) => {
        const ledger = valid(idSchema, id),
          data = valid(ledgerUpdateSchema, input);
        const old = await ownedLedger(sql, actor, ledger);
        if (
          data.base_currency !== undefined &&
          data.base_currency !== old.base_currency
        )
          await assertEmpty(sql, ledger);
        const [row] = await sql<
          Ledger[]
        >`UPDATE ledgers SET name=${data.name ?? old.name},base_currency=${data.base_currency ?? old.base_currency} WHERE id=${ledger} RETURNING id,name,base_currency,locked_until::text`;
        return row!;
      });
    },
    async setLock(actor: string, id: unknown, input: unknown) {
      let action: AuditAction = 'ledger.lock';
      return mutation(
        db,
        actor,
        () => action,
        async (sql) => {
          const ledger = valid(idSchema, id);
          const data = valid(ledgerLockSchema, input);
          action = data.locked_until === null ? 'ledger.unlock' : 'ledger.lock';
          const old = await ownedLedger(sql, actor, ledger);
          // Determine the attempted action before a missing-confirmation error is audited.
          if (
            old.locked_until !== null &&
            (data.locked_until === null || data.locked_until < old.locked_until)
          )
            action = 'ledger.unlock';
          action = lockChange(
            old.locked_until,
            data.locked_until,
            data.confirm_unlock,
          );
          const [row] = await sql<
            Ledger[]
          >`UPDATE ledgers SET locked_until=${data.locked_until} WHERE id=${ledger} RETURNING id,name,base_currency,locked_until::text`;
          return row!;
        },
      );
    },
    async remove(actor: string, id: unknown) {
      return mutation(db, actor, 'ledger.delete', async (sql) => {
        const ledger = valid(idSchema, id);
        await ownedLedger(sql, actor, ledger);
        await assertEmpty(sql, ledger);
        await sql`DELETE FROM ledgers WHERE id=${ledger}`;
      });
    },
  };
}
