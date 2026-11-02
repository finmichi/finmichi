// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import { backupService, backupFilename, restoreService } from '@finmichi/core';
export function backupRoutes(
  app: FastifyInstance,
  db: Database,
  appVersion: string,
) {
  const service = backupService(db, appVersion),
    restores = restoreService(db);
  const options = { bodyLimit: 50 * 1024 * 1024 };
  app.post('/api/backup-restores/preview', options, (r) =>
    restores.preview(r.actor!.id, r.body, r.query),
  );
  app.post('/api/backup-restores/confirm', options, async (r, reply) =>
    reply.code(201).send(await restores.confirm(r.actor!.id, r.body, r.query)),
  );
  app.get<{ Params: { ledger: string } }>(
    '/api/ledgers/:ledger/backup.json',
    async (r, reply) => {
      const backup = await service.download(r.actor!.id, r.params.ledger);
      const name = backupFilename(backup.ledger.name, backup.exportedAt);
      return reply
        .header('cache-control', 'no-store')
        .header('content-type', 'application/json; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="finmichi.json"; filename*=UTF-8''${encodeURIComponent(name)}`,
        )
        .send(backup);
    },
  );
}
