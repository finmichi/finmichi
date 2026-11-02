// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { financeService } from '@finmichi/core';
export function financeRoutes(app: FastifyInstance, db: Database) {
  const s = financeService(db),
    base = '/api/ledgers/:ledger';
  type P = { Params: { ledger: string; item: string } };
  app.get<P>(base + '/cards', (r) => s.cards(r.actor!.id, r.params.ledger));
  app.get<P>(base + '/loans', (r) => s.loans(r.actor!.id, r.params.ledger));
  app.put<P>(base + '/cards', (r) =>
    s.saveCard(r.actor!.id, r.params.ledger, r.body),
  );
  app.put<P>(base + '/loans', (r) =>
    s.saveLoan(r.actor!.id, r.params.ledger, r.body),
  );
  for (const type of ['card', 'loan'] as const)
    app.delete<P>(base + '/' + type + 's/:item', async (r, reply) => {
      await s.remove(r.actor!.id, r.params.ledger, r.params.item, type);
      return reply.code(204).send();
    });
}
