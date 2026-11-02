// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { life2023Service } from '@finmichi/core';
export function life2023Routes(app: FastifyInstance, db: Database) {
  const service = life2023Service(db),
    base = '/api/ledgers/:ledger/imports/life2023';
  type P = { Params: { ledger: string } };
  app.post<P>(base + '/preview', { bodyLimit: 6 * 1024 * 1024 }, (r) =>
    service.preview(r.actor!.id, r.params.ledger, r.body),
  );
  app.post<P>(
    base + '/confirm',
    { bodyLimit: 6 * 1024 * 1024 },
    async (r, reply) =>
      reply
        .code(201)
        .send(await service.confirm(r.actor!.id, r.params.ledger, r.body)),
  );
}
