// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { depositService } from '@finmichi/core';
export function depositRoutes(app: FastifyInstance, db: Database) {
  const s = depositService(db),
    root = '/api/ledgers/:ledger/deposits';
  type P = { Params: { ledger: string; id: string; posting: string } };
  app.get<P>(root, (r) => s.list(r.actor!.id, r.params.ledger, r.query));
  app.post<P>(root, (r) => s.save(r.actor!.id, r.params.ledger, r.body));
  app.put<P>(root + '/:id', (r) =>
    s.save(r.actor!.id, r.params.ledger, r.body, r.params.id),
  );
  app.delete<P>(root + '/:id', (r) =>
    s.delete(r.actor!.id, r.params.ledger, r.params.id),
  );
  app.post<P>(root + '/:id/preview', (r) =>
    s.preview(r.actor!.id, r.params.ledger, r.params.id, r.body),
  );
  app.post<P>(root + '/:id/interest', (r) =>
    s.apply(r.actor!.id, r.params.ledger, r.params.id, 'interest', r.body),
  );
  app.post<P>(root + '/:id/settle', (r) =>
    s.apply(r.actor!.id, r.params.ledger, r.params.id, 'settlement', r.body),
  );
  app.delete<P>(root + '/:id/postings/:posting', (r) =>
    s.apply(
      r.actor!.id,
      r.params.ledger,
      r.params.id,
      'revoke',
      r.body,
      r.params.posting,
    ),
  );
  app.get<P>('/api/ledgers/:ledger/reports/deposits', (r) =>
    s.list(r.actor!.id, r.params.ledger, r.query),
  );
}
