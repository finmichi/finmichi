// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { dividendService } from '@finmichi/core';
export function dividendRoutes(app: FastifyInstance, db: Database) {
  const s = dividendService(db);
  type P = {
    Params: { ledger: string; id: string };
    Querystring: { ex_date?: string };
  };
  const root = '/api/ledgers/:ledger';
  app.get<P>(root + '/dividends', (r) => s.list(r.actor!.id, r.params.ledger));
  app.get<P>(root + '/dividends/:id', (r) =>
    s.get(r.actor!.id, r.params.ledger, r.params.id),
  );
  app.get<P>(root + '/income-codes', (r) =>
    s.codes(r.actor!.id, r.params.ledger),
  );
  app.post<P>(root + '/income-codes/initialize', (r) =>
    s.initialize(r.actor!.id, r.params.ledger),
  );
  app.post<P>(root + '/income-codes', (r) =>
    s.saveCode(r.actor!.id, r.params.ledger, undefined, r.body),
  );
  app.put<P>(root + '/income-codes/:id', (r) =>
    s.saveCode(r.actor!.id, r.params.ledger, r.params.id, r.body),
  );
  app.delete<P>(root + '/income-codes/:id', (r) =>
    s.deleteCode(r.actor!.id, r.params.ledger, r.params.id),
  );
  app.get<P>(root + '/securities/:id/dividend-shares', (r) =>
    s.shares(r.actor!.id, r.params.ledger, r.params.id, r.query.ex_date),
  );
  app.post<P>(root + '/dividend-preview', (r) =>
    s.preview(r.actor!.id, r.params.ledger, r.body),
  );
  app.post<P>(root + '/dividends', (r) =>
    s.apply(r.actor!.id, r.params.ledger, 'create', r.body),
  );
  app.put<P>(root + '/dividends/:id', (r) =>
    s.apply(r.actor!.id, r.params.ledger, 'update', r.body, r.params.id),
  );
  app.delete<P>(root + '/dividends/:id', (r) =>
    s.apply(r.actor!.id, r.params.ledger, 'delete', r.body, r.params.id),
  );
  app.get<P>(root + '/reports/dividends', (r) =>
    s.report(r.actor!.id, r.params.ledger, r.query),
  );
}
