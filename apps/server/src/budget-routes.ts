// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { budgetService } from '@finmichi/core';
export function budgetRoutes(app: FastifyInstance, db: Database) {
  const s = budgetService(db),
    base = '/api/ledgers/:ledger/budgets';
  type P = { Params: { ledger: string } };
  app.get<P>(base, (r) => s.list(r.actor!.id, r.params.ledger, r.query));
  app.put<P>(base, (r) => s.save(r.actor!.id, r.params.ledger, r.body));
  app.post<P>(base + '/distribute', (r) =>
    s.distribute(r.actor!.id, r.params.ledger, r.body),
  );
  app.delete<P>(base, async (r, reply) => {
    await s.remove(r.actor!.id, r.params.ledger, r.query);
    return reply.code(204).send();
  });
}
