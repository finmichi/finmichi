// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '@finmichi/db';
import { DomainError, mutation, ownedLedger, valid } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import { patCreateSchema, type PersonalAccessToken } from './pat-schemas.js';
export const hashPat = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export function patService(db: Database) {
  return {
    async list(actor: string) {
      valid(idSchema, actor);
      return db<
        PersonalAccessToken[]
      >`SELECT id,token_prefix,scope,ledger_ids,mask_text,created_at::text,expires_at::text,last_used_at::text,revoked_at::text FROM personal_access_tokens WHERE user_id=${actor} ORDER BY created_at DESC,id DESC`;
    },
    async create(actor: string, input: unknown) {
      return mutation(db, actor, 'pat.create', async (sql) => {
        const q = valid(patCreateSchema, input);
        // Serialize creations across instances without blocking FK KEY SHARE checks
        // from ordinary audited operations that already hold ledger locks.
        await sql`SELECT id FROM users WHERE id=${actor} FOR NO KEY UPDATE`;
        const [count] =
          await sql`SELECT count(*)::int AS n FROM personal_access_tokens WHERE user_id=${actor} AND revoked_at IS NULL AND expires_at>now()`;
        if (count!.n >= 10) throw new DomainError('pat_limit_reached', 409);
        for (const id of [...(q.ledger_ids ?? [])].sort())
          await ownedLedger(sql, actor, id);
        const token = 'llp_' + randomBytes(32).toString('base64url');
        const [row] = await sql<
          PersonalAccessToken[]
        >`INSERT INTO personal_access_tokens(user_id,token_hash,token_prefix,scope,ledger_ids,mask_text,expires_at) VALUES (${actor},${hashPat(token)},${token.slice(0, 8)},${q.scope},${q.ledger_ids},${q.mask_text},now()+${q.expires_in_days}*interval '1 day') RETURNING id,token_prefix,scope,ledger_ids,mask_text,created_at::text,expires_at::text,last_used_at::text,revoked_at::text`;
        return { ...row!, token };
      });
    },
    async revoke(actor: string, input: unknown) {
      return mutation(db, actor, 'pat.revoke', async (sql) => {
        const id = valid(idSchema, input);
        const rows =
          await sql`UPDATE personal_access_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE id=${id} AND user_id=${actor} RETURNING id`;
        if (!rows.length) throw new DomainError('not_found', 404);
      });
    },
    async authenticate(token: string) {
      if (!/^llp_[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const [row] = await db<
        (PersonalAccessToken & { user_id: string })[]
      >`UPDATE personal_access_tokens SET last_used_at=now() WHERE token_hash=${hashPat(token)} AND revoked_at IS NULL AND expires_at>now() AND scope IN ('read','draft') RETURNING id,user_id,token_prefix,scope,ledger_ids,mask_text,created_at::text,expires_at::text,last_used_at::text,revoked_at::text`;
      return row ?? null;
    },
  };
}
