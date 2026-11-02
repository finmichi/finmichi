// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { queryService, queryCsv, life2023Export } from '@finmichi/core';
export function queryRoutes(app: FastifyInstance, db: Database) {
  const service = queryService(db),
    base = '/api/ledgers/:ledger/transactions';
  type P = { Params: { ledger: string } };
  app.get<P>(base, (r) =>
    service.search(r.actor!.id, r.params.ledger, r.query),
  );
  app.get<P>(base + '/export.csv', async (r, reply) => {
    const csv = await queryCsv(db, r.actor!.id, r.params.ledger, r.query);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="finmichi.csv"')
      .header('cache-control', 'no-store')
      .send(csv);
  });
  app.get<P>(base + '/life2023-export', async (r, reply) => {
    reply.header('cache-control', 'no-store');
    return life2023Export(db, r.actor!.id, r.params.ledger, r.query);
  });
  app.get<P>(base + '/summary', (r) =>
    service.summary(r.actor!.id, r.params.ledger, r.query),
  );
}
