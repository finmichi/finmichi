// SPDX-License-Identifier: AGPL-3.0-only
import { queryRoutes } from './query-routes.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { transactionService } from '@finmichi/core';
export function transactionRoutes(app: FastifyInstance, db: Database) {
  const service = transactionService(db),
    base = '/api/ledgers/:ledger/transactions';
  type P = { Params: { ledger: string; id: string } };
  queryRoutes(app, db);
  app.get<P>(base + '/:id', (r) =>
    service.get(r.actor!.id, r.params.ledger, r.params.id),
  );
  app.post<P>(base + '/preview', (r) =>
    service.preview(r.actor!.id, r.params.ledger, r.body),
  );
  app.post<P>(base + '/:id/preview', (r) =>
    service.preview(r.actor!.id, r.params.ledger, r.body, r.params.id),
  );
  app.post<P>(base, async (r, reply) =>
    reply
      .code(201)
      .send(await service.create(r.actor!.id, r.params.ledger, r.body)),
  );
  app.patch<P>(base + '/:id', (r) =>
    service.update(r.actor!.id, r.params.ledger, r.params.id, r.body),
  );
  app.delete<P>(base + '/:id', async (r, reply) => {
    await service.remove(r.actor!.id, r.params.ledger, r.params.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { ledger: string }; Querystring: { date?: string } }>(
    '/api/ledgers/:ledger/exchange-rates',
    (r) => service.rates(r.actor!.id, r.params.ledger, r.query.date),
  );
}
