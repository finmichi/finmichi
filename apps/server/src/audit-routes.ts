// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { auditService } from '@finmichi/core';
export function auditRoutes(app: FastifyInstance, db: Database) {
  const service = auditService(db);
  app.get('/api/audit-logs', (r) => service.list(r.actor!.id, r.query));
  app.get<{ Params: { id: string } }>('/api/audit-logs/:id', (r) =>
    service.get(r.actor!.id, r.params.id),
  );
}
