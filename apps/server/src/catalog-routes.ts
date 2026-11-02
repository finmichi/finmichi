// SPDX-License-Identifier: AGPL-3.0-only
import { namedRoutes } from './named-routes.js';
import { itemRoutes } from './item-routes.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { ledgerService } from '@finmichi/core';
declare module 'fastify' {
  interface FastifyRequest {
    actor: { id: string; subject: string } | null;
  }
}
export function catalogRoutes(app: FastifyInstance, db: Database) {
  itemRoutes(app, db);
  namedRoutes(app, db, 'payees');
  namedRoutes(app, db, 'projects');
  namedRoutes(app, db, 'memo_templates');
  const ledgers = ledgerService(db);
  app.get('/api/ledgers', (r) => ledgers.list(r.actor!.id));
  app.post('/api/ledgers', async (r, reply) =>
    reply.code(201).send(await ledgers.create(r.actor!.id, r.body)),
  );
  app.get<{ Params: { ledger: string } }>('/api/ledgers/:ledger', (r) =>
    ledgers.get(r.actor!.id, r.params.ledger),
  );
  app.patch<{ Params: { ledger: string } }>('/api/ledgers/:ledger', (r) =>
    ledgers.update(r.actor!.id, r.params.ledger, r.body),
  );
  app.patch<{ Params: { ledger: string } }>('/api/ledgers/:ledger/lock', (r) =>
    ledgers.setLock(r.actor!.id, r.params.ledger, r.body),
  );
  app.delete<{ Params: { ledger: string } }>(
    '/api/ledgers/:ledger',
    async (r, reply) => {
      await ledgers.remove(r.actor!.id, r.params.ledger);
      return reply.code(204).send();
    },
  );
}
