// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction } from '@finmichi/db';
import { DomainError, mutation, ownedLedger, valid } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import {
  transactionCreateSchema,
  type Preview,
} from './transaction-schemas.js';
import { previewTransaction, createTransaction } from './transactions.js';
import { scaled } from './finance-schemas.js';
import {
  DEFAULT_DRAFT_LIMIT,
  draftLimitSchema,
  draftApproveSchema,
  draftQuerySchema,
  type TransactionDraft,
  type DraftPage,
} from './draft-schemas.js';
import type { PersonalAccessToken } from './pat-schemas.js';
type Principal = PersonalAccessToken & { user_id: string };
const columns = `d.id,d.ledger_id,p.token_prefix,d.payload,d.preview,d.note,d.status,to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,d.decided_at::text,d.transaction_id`;
const cursorSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  id: idSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
async function pending(sql: Transaction, ledger: string, id: string) {
  const [r] = await sql<
    (Pick<TransactionDraft, 'id' | 'status' | 'payload'> & {
      overdue: boolean;
    })[]
  >`SELECT d.id,d.status,d.payload,created_at<=now()-interval '14 days' AS overdue FROM transaction_drafts d WHERE ledger_id=${ledger} AND id=${id} FOR UPDATE`;
  if (!r) throw new DomainError('not_found', 404);
  if (r.status === 'expired') throw new DomainError('draft_expired', 409);
  if (r.status !== 'pending') throw new DomainError('draft_not_pending', 409);
  if (r.overdue) throw new DomainError('draft_expired', 409);
  return r;
}
export function draftService(
  db: Database,
  maxBaseAmount = DEFAULT_DRAFT_LIMIT,
) {
  const limit = valid(draftLimitSchema, maxBaseAmount);
  function amountCheck(preview: Pick<Preview, 'entries'>) {
    const amount = preview.entries.reduce((s, e) => {
      const n = scaled(e.base_amount, 6);
      return s + (n > 0n ? n : 0n);
    }, 0n);
    if (amount > scaled(limit, 6))
      throw new DomainError('draft_amount_limit', 400);
  }
  async function list(
    actor: string,
    input: unknown,
    ledger?: string,
    principal?: Principal,
  ): Promise<DraftPage> {
    const q = valid(draftQuerySchema, input);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          actor,
          ledger,
          principal?.id,
          principal?.ledger_ids,
          q.status,
        ]),
      )
      .digest('hex');
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (q.cursor)
      try {
        const b = Buffer.from(q.cursor, 'base64url');
        if (b.toString('base64url') !== q.cursor) throw new Error();
        cursor = cursorSchema.parse(JSON.parse(b.toString('utf8')));
        if (cursor.fingerprint !== fingerprint) throw new Error();
      } catch {
        throw new DomainError('invalid_cursor', 400);
      }
    return (await db.begin(async (sql) => {
      if (ledger) await ownedLedger(sql, actor, ledger, false);
      const scope = sql`l.owner_id=${actor} ${ledger ? sql`AND d.ledger_id=${ledger}` : sql``} ${principal ? sql`AND d.token_id=${principal.id} ${principal.ledger_ids === null ? sql`` : sql`AND d.ledger_id=ANY(${principal.ledger_ids}::uuid[])`}` : sql``}`;
      const result = await sql<
        TransactionDraft[]
      >`SELECT ${sql.unsafe(columns)} FROM transaction_drafts d JOIN ledgers l ON l.id=d.ledger_id LEFT JOIN personal_access_tokens p ON p.id=d.token_id WHERE ${scope} ${q.status ? sql`AND d.status=${q.status}` : sql``} ${cursor ? sql`AND (d.created_at,d.id)<(${cursor.at}::text::timestamptz,${cursor.id}::uuid)` : sql``} ORDER BY d.created_at DESC,d.id DESC LIMIT ${q.limit + 1}`;
      const [count] =
        await sql`SELECT count(*)::int n FROM transaction_drafts d JOIN ledgers l ON l.id=d.ledger_id WHERE ${scope} AND d.status='pending'`;
      const items = result.slice(0, q.limit),
        last = items.at(-1);
      return {
        items,
        pending_count: Number(count!.n),
        max_base_amount: limit,
        next_cursor:
          result.length > q.limit && last
            ? Buffer.from(
                JSON.stringify({
                  at: last.created_at,
                  id: last.id,
                  fingerprint,
                }),
              ).toString('base64url')
            : null,
      };
    })) as DraftPage;
  }
  return {
    async create(p: Principal, ledgerId: unknown, input: unknown, note = '') {
      return mutation(db, p.user_id, 'draft.create', async (sql) => {
        const ledger = valid(idSchema, ledgerId),
          data = valid(transactionCreateSchema, input);
        valid(z.string().max(500), note);
        const l = await ownedLedger(sql, p.user_id, ledger);
        const [token] =
          await sql`SELECT scope,ledger_ids FROM personal_access_tokens WHERE id=${p.id} AND user_id=${p.user_id} AND revoked_at IS NULL AND expires_at>now() FOR SHARE`;
        if (!token) throw new DomainError('unauthorized', 401);
        if (token.scope !== 'draft')
          throw new DomainError('insufficient_scope', 403);
        if (token.ledger_ids !== null && !token.ledger_ids.includes(ledger))
          throw new DomainError('not_found', 404);
        const preview = await previewTransaction(sql, l, data);
        amountCheck(preview);
        const [count] =
          await sql`SELECT count(*)::int n FROM transaction_drafts WHERE ledger_id=${ledger} AND status='pending'`;
        if (count!.n >= 50) throw new DomainError('draft_pending_limit', 409);
        const [r] =
          await sql`INSERT INTO transaction_drafts(ledger_id,token_id,payload,preview,note) VALUES(${ledger},${p.id},${sql.json(data)},${sql.json({ ...preview, fx_comparisons: preview.fx_comparisons.map((c) => ({ ...c })) })},${note}) RETURNING id,status`;
        return { ...r!, preview };
      });
    },
    list(actor: string, ledgerId: unknown, input: unknown = {}) {
      return list(actor, input, valid(idSchema, ledgerId));
    },
    listForToken(p: Principal, input: unknown = {}) {
      if (p.scope !== 'draft') throw new DomainError('insufficient_scope', 403);
      return list(p.user_id, input, undefined, p);
    },
    async get(actor: string, ledgerId: unknown, draftId: unknown) {
      const ledger = valid(idSchema, ledgerId),
        id = valid(idSchema, draftId);
      return db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger, false);
        const [r] = await sql<
          TransactionDraft[]
        >`SELECT ${sql.unsafe(columns)} FROM transaction_drafts d LEFT JOIN personal_access_tokens p ON p.id=d.token_id WHERE d.ledger_id=${ledger} AND d.id=${id}`;
        if (!r) throw new DomainError('not_found', 404);
        return r;
      });
    },
    async approve(
      actor: string,
      ledgerId: unknown,
      draftId: unknown,
      input: unknown = {},
    ) {
      return mutation(db, actor, 'draft.approve', async (sql) => {
        const ledger = valid(idSchema, ledgerId),
          id = valid(idSchema, draftId),
          q = valid(draftApproveSchema, input);
        const l = await ownedLedger(sql, actor, ledger),
          r = await pending(sql, ledger, id);
        const data = valid(transactionCreateSchema, q.payload ?? r.payload);
        const preview = await previewTransaction(sql, l, data);
        amountCheck(preview);
        const tx = await createTransaction(sql, l, data);
        await sql`UPDATE transactions SET source_system='mcp-draft',source_id=${id} WHERE ledger_id=${ledger} AND id=${tx.id}`;
        await sql`UPDATE transaction_drafts SET payload=${sql.json(data)},preview=${sql.json({ ...preview, fx_comparisons: preview.fx_comparisons.map((c) => ({ ...c })) })},status='approved',decided_at=now(),transaction_id=${tx.id} WHERE ledger_id=${ledger} AND id=${id}`;
        return tx;
      });
    },
    async reject(
      actor: string,
      ledgerId: unknown,
      draftId: unknown,
      input: unknown = {},
    ) {
      return mutation(db, actor, 'draft.reject', async (sql) => {
        valid(z.strictObject({}), input);
        const ledger = valid(idSchema, ledgerId),
          id = valid(idSchema, draftId);
        await ownedLedger(sql, actor, ledger);
        await pending(sql, ledger, id);
        await sql`UPDATE transaction_drafts SET status='rejected',decided_at=now() WHERE ledger_id=${ledger} AND id=${id}`;
      });
    },
    async suggestItems(actor: string, ledgerId: unknown, text: unknown) {
      const ledger = valid(idSchema, ledgerId),
        query = valid(z.string().trim().min(1).max(2000), text);
      return db.begin(async (sql) => {
        await ownedLedger(sql, actor, ledger, false);
        return sql`SELECT i.id,i.name,i.kind,i.currency,count(*)::int AS frequency,max(t.created_at)::text AS last_used_at FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id AND t.ledger_id=e.ledger_id JOIN items i ON i.id=e.item_id AND i.ledger_id=e.ledger_id LEFT JOIN payees p ON p.id=t.payee_id AND p.ledger_id=t.ledger_id WHERE t.ledger_id=${ledger} AND NOT i.archived AND (strpos(lower(t.memo),lower(${query}))>0 OR strpos(lower(coalesce(p.name,'')),lower(${query}))>0) GROUP BY i.id ORDER BY frequency DESC,max(t.created_at) DESC,i.id LIMIT 5`;
      });
    },
  };
}
export async function expireTransactionDrafts(db: Database, now = new Date()) {
  const rows =
    await db`WITH expired AS (UPDATE transaction_drafts SET status='expired',decided_at=${now.toISOString()} WHERE status='pending' AND created_at<=${now.toISOString()}::timestamptz-interval '14 days' RETURNING ledger_id) INSERT INTO audit_logs(user_id,action,outcome) SELECT l.owner_id,'draft.expire','success' FROM expired e JOIN ledgers l ON l.id=e.ledger_id RETURNING id`;
  return rows.length;
}
