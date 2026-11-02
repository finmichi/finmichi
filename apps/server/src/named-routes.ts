// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { namedRecordService, type NamedTable } from '@finmichi/core';
export function namedRoutes(
  app: FastifyInstance,
  db: Database,
  table: NamedTable,
) {
  const service = namedRecordService(db, table),
    path = `/api/ledgers/:ledger/${table}`;
  type List = {
    Params: { ledger: string };
    Querystring: Record<string, unknown>;
  };
  type One = { Params: { ledger: string; record: string } };
  app.get<List>(path, (r) =>
    service.list(r.actor!.id, r.params.ledger, r.query),
  );
  app.post<List>(path, async (r, reply) =>
    reply
      .code(201)
      .send(await service.create(r.actor!.id, r.params.ledger, r.body)),
  );
  app.get<One>(path + '/:record', (r) =>
    service.get(r.actor!.id, r.params.ledger, r.params.record),
  );
  app.patch<One>(path + '/:record', (r) =>
    service.update(r.actor!.id, r.params.ledger, r.params.record, r.body),
  );
  app.delete<One>(path + '/:record', async (r, reply) => {
    await service.remove(r.actor!.id, r.params.ledger, r.params.record);
    return reply.code(204).send();
  });
}
