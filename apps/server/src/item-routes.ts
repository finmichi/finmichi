// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { itemService } from '@finmichi/core';
export function itemRoutes(app: FastifyInstance, db: Database) {
  const items = itemService(db);
  type List = {
    Params: { ledger: string };
    Querystring: Record<string, unknown>;
  };
  type One = { Params: { ledger: string; item: string } };
  const path = '/api/ledgers/:ledger/items';
  app.get<List>(path, (r) => items.list(r.actor!.id, r.params.ledger, r.query));
  app.post<List>(path, async (r, reply) =>
    reply
      .code(201)
      .send(await items.create(r.actor!.id, r.params.ledger, r.body)),
  );
  app.get<One>(path + '/:item', (r) =>
    items.get(r.actor!.id, r.params.ledger, r.params.item),
  );
  app.patch<One>(path + '/:item', (r) =>
    items.update(r.actor!.id, r.params.ledger, r.params.item, r.body),
  );
}
