// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { securityService, securityReports } from '@finmichi/core';
export function securitiesRoutes(app: FastifyInstance, db: Database) {
  const s = securityService(db),
    reports = securityReports(db);
  type P = { Params: { ledger: string; id: string; trade: string } };
  const root = '/api/ledgers/:ledger/securities';
  app.get<P>('/api/ledgers/:ledger/reports/holdings', (r) =>
    reports.holdings(r.actor!.id, r.params.ledger, r.query),
  );
  app.get<P>('/api/ledgers/:ledger/reports/realized-gains', (r) =>
    reports.realized(r.actor!.id, r.params.ledger, r.query),
  );
  app.get<P>(root + '/:id/trade/:trade', (r) =>
    reports.trade(r.actor!.id, r.params.ledger, r.params.id, r.params.trade),
  );
  app.get<P>(root + '/:id/trades', (r) =>
    reports.history(r.actor!.id, r.params.ledger, r.params.id, r.query),
  );
  app.get<P>('/api/ledgers/:ledger/manual-prices', (r) =>
    reports.prices(r.actor!.id, r.params.ledger),
  );
  app.get<P>(root, (r) => s.list(r.actor!.id, r.params.ledger));
  app.post<P>(root, (r) => s.create(r.actor!.id, r.params.ledger, r.body));
  app.get<P>(root + '/:id', (r) =>
    s.get(r.actor!.id, r.params.ledger, r.params.id),
  );
  app.patch<P>(root + '/:id', (r) =>
    s.update(r.actor!.id, r.params.ledger, r.params.id, r.body),
  );
  app.delete<P>(root + '/:id', (r) =>
    s.remove(r.actor!.id, r.params.ledger, r.params.id),
  );
  app.post<P>(root + '/:id/trade-preview', (r) =>
    s.preview(r.actor!.id, r.params.ledger, r.params.id, r.body),
  );
  app.post<P>(root + '/:id/trades', (r) =>
    s.apply(r.actor!.id, r.params.ledger, r.params.id, 'create', r.body),
  );
  app.put<P>(root + '/:id/trades/:trade', (r) =>
    s.apply(
      r.actor!.id,
      r.params.ledger,
      r.params.id,
      'update',
      r.body,
      r.params.trade,
    ),
  );
  app.delete<P>(root + '/:id/trades/:trade', (r) =>
    s.apply(
      r.actor!.id,
      r.params.ledger,
      r.params.id,
      'delete',
      r.body,
      r.params.trade,
    ),
  );
  app.post<P>('/api/ledgers/:ledger/manual-prices', (r) =>
    s.price(r.actor!.id, r.params.ledger, r.body),
  );
  app.delete<P>('/api/ledgers/:ledger/manual-prices/:id', (r) =>
    s.removePrice(r.actor!.id, r.params.ledger, r.params.id),
  );
}
