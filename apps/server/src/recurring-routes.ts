// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { recurringService } from '@finmichi/core';
export function recurringRoutes(app: FastifyInstance, db: Database) {
  const s = recurringService(db),
    base = '/api/ledgers/:ledger/recurring';
  type P = { Params: { ledger: string; id: string } };
  app.get<P>(base, (r) => s.state(r.actor!.id, r.params.ledger));
  app.post<P>(base, async (r, reply) =>
    reply.code(201).send(await s.save(r.actor!.id, r.params.ledger, r.body)),
  );
  app.put<P>(base + '/:id', (r) =>
    s.save(r.actor!.id, r.params.ledger, r.body, r.params.id),
  );
  app.delete<P>(base + '/:id', async (r, reply) => {
    await s.remove(r.actor!.id, r.params.ledger, r.params.id);
    return reply.code(204).send();
  });
  app.post<P>(base + '/generate', (r) =>
    s.generate(r.actor!.id, r.params.ledger),
  );
  app.get<P>(base + '/occurrences', (r) =>
    s.occurrences(r.actor!.id, r.params.ledger, r.query),
  );
  app.patch<P>(base + '/occurrences/:id', (r) =>
    s.editOccurrence(r.actor!.id, r.params.ledger, r.params.id, r.body),
  );
  app.post<P>(base + '/occurrences/:id/post', (r) =>
    s.post(r.actor!.id, r.params.ledger, r.params.id),
  );
  app.post<P>(base + '/occurrences/:id/skip', (r) =>
    s.skip(r.actor!.id, r.params.ledger, r.params.id),
  );
  app.post<P>(base + '/post', (r) =>
    s.bulkPost(r.actor!.id, r.params.ledger, r.body),
  );
}
