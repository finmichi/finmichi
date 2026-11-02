// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '@finmichi/db';
import { DomainError, valid } from './catalog.js';
import { idSchema } from './catalog-schemas.js';
import {
  auditIdSchema,
  auditQuerySchema,
  type AuditRow,
  type AuditPage,
} from './audit-schemas.js';
const cursorSchema = z.strictObject({
  v: z.literal(1),
  id: auditIdSchema,
  created_at: z.iso.datetime({ precision: 6 }),
  filter: z.string().regex(/^[a-f0-9]{64}$/),
});
export function auditService(db: Database) {
  return {
    async get(actor: string, input: unknown): Promise<AuditRow> {
      valid(idSchema, actor);
      const id = valid(auditIdSchema, input);
      const [row] = await db<
        AuditRow[]
      >`SELECT id::text,action,outcome,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM audit_logs WHERE id=${id} AND user_id=${actor}`;
      if (!row) throw new DomainError('not_found', 404);
      return row;
    },
    async list(actor: string, input: unknown = {}): Promise<AuditPage> {
      valid(idSchema, actor);
      const q = valid(auditQuerySchema, input);
      const filter = createHash('sha256')
        .update(
          JSON.stringify([
            actor,
            q.from ?? null,
            q.to ?? null,
            q.action ?? null,
            q.outcome ?? null,
          ]),
        )
        .digest('hex');
      let cursor: z.infer<typeof cursorSchema> | null = null;
      if (q.cursor) {
        try {
          cursor = cursorSchema.parse(
            JSON.parse(Buffer.from(q.cursor, 'base64url').toString()),
          );
        } catch {
          throw new DomainError('invalid_cursor', 400);
        }
        // An unowned or absent anchor is always indistinguishable from missing data.
        const anchor = await this.get(actor, cursor.id);
        if (cursor.filter !== filter || cursor.created_at !== anchor.created_at)
          throw new DomainError('invalid_cursor', 400);
      }
      const rows = await db<
        AuditRow[]
      >`SELECT id::text,action,outcome,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM audit_logs a
        WHERE user_id=${actor}
        AND (${q.from ?? null}::text::timestamptz IS NULL OR created_at>=${q.from ?? null}::text::timestamptz)
        AND (${q.to ?? null}::text::timestamptz IS NULL OR created_at<=${q.to ?? null}::text::timestamptz)
        AND (${q.action ?? null}::text IS NULL OR action=${q.action ?? null})
        AND (${q.outcome ?? null}::text IS NULL OR outcome=${q.outcome ?? null})
        AND (${cursor?.created_at ?? null}::text::timestamptz IS NULL OR (created_at,id)<(${cursor?.created_at ?? null}::text::timestamptz,${cursor?.id ?? null}::bigint))
        ORDER BY a.created_at DESC,a.id DESC LIMIT ${q.limit + 1}`;
      const items = rows.slice(0, q.limit),
        last = items.at(-1);
      return {
        items,
        next_cursor:
          rows.length > q.limit && last
            ? Buffer.from(
                JSON.stringify({
                  v: 1,
                  id: last.id,
                  created_at: last.created_at,
                  filter,
                }),
              ).toString('base64url')
            : null,
      };
    },
  };
}
