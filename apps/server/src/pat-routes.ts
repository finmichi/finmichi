// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { patService } from '@finmichi/core';
export function patRoutes(app: FastifyInstance, db: Database) {
  const pats = patService(db);
  app.get('/api/pats', (r, reply) => {
    reply.header('cache-control', 'no-store');
    return pats.list(r.actor!.id);
  });
  app.post('/api/pats', async (r, reply) =>
    reply
      .header('cache-control', 'no-store')
      .code(201)
      .send(await pats.create(r.actor!.id, r.body)),
  );
  app.post<{ Params: { id: string } }>(
    '/api/pats/:id/revoke',
    async (r, reply) => {
      await pats.revoke(r.actor!.id, r.params.id);
      return reply.code(204).send();
    },
  );
}
