// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { reminderService } from '@finmichi/core';
export function reminderRoutes(app: FastifyInstance, db: Database) {
  const s = reminderService(db),
    base = '/api/ledgers/:ledger/reminders';
  type P = { Params: { ledger: string } };
  app.get<P>(base, (r) => s.list(r.actor!.id, r.params.ledger));
  app.post<P>(base + '/read', (r) =>
    s.markRead(r.actor!.id, r.params.ledger, r.body),
  );
  app.get<P>(base + '/settings', (r) =>
    s.settings(r.actor!.id, r.params.ledger),
  );
  app.put<P>(base + '/settings', (r) =>
    s.saveSettings(r.actor!.id, r.params.ledger, r.body),
  );
}
