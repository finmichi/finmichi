// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { draftService } from '@finmichi/core';
// All /api routes are protected by the app's cookie-session and Origin hooks.
export function draftRoutes(
  app: FastifyInstance,
  db: Database,
  limit?: string,
) {
  const s = draftService(db, limit),
    base = '/api/ledgers/:ledger/drafts';
  type P = { Params: { ledger: string; id: string } };
  app.get<P>(base, (r) => s.list(r.actor!.id, r.params.ledger, r.query));
  app.get<P>(base + '/:id', (r) =>
    s.get(r.actor!.id, r.params.ledger, r.params.id),
  );
  app.post<P>(base + '/:id/approve', (r) =>
    s.approve(r.actor!.id, r.params.ledger, r.params.id, r.body ?? {}),
  );
  app.post<P>(base + '/:id/reject', async (r, reply) => {
    await s.reject(r.actor!.id, r.params.ledger, r.params.id, r.body ?? {});
    return reply.code(204).send();
  });
}
