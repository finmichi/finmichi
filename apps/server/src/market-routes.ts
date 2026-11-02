// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { marketService } from '@finmichi/core';
export function marketRoutes(app: FastifyInstance, db: Database) {
  const service = marketService(db);
  type P = { Params: { ledger: string } };
  app.get<P>('/api/ledgers/:ledger/market', (r) =>
    service.dashboard(r.actor!.id, r.params.ledger, r.query),
  );
  app.post<P>('/api/ledgers/:ledger/market/fx-preview', (r) =>
    service.previewUpload(r.actor!.id, r.params.ledger, r.body),
  );
  app.post<P>('/api/ledgers/:ledger/market/fx-upload', (r) =>
    service.upload(r.actor!.id, r.params.ledger, r.body),
  );
}
