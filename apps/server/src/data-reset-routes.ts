// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '@finmichi/db';
import {
  dataResetService,
  backupService,
  backupFilename,
  resetBackupSchema,
  DomainError,
} from '@finmichi/core';

export function dataResetRoutes(
  app: FastifyInstance,
  db: Database,
  allowFactoryReset: boolean,
  version: string,
) {
  const service = dataResetService(db, allowFactoryReset),
    backups = backupService(db, version);
  function browser(r: FastifyRequest) {
    if (r.headers.authorization !== undefined || !r.cookies.session)
      throw new DomainError('browser_session_required', 403);
    return r.cookies.session;
  }
  app.post<{ Params: { ledger: string } }>(
    '/api/ledgers/:ledger/purge-preview',
    (r) =>
      service.preview(
        r.actor!.id,
        browser(r),
        'purge',
        r.params.ledger,
        r.body ?? {},
      ),
  );
  app.post('/api/factory-reset-preview', (r) =>
    service.preview(
      r.actor!.id,
      browser(r),
      'factory',
      undefined,
      r.body ?? {},
    ),
  );
  app.post<{ Params: { ledger: string } }>('/api/ledgers/:ledger/purge', (r) =>
    service.execute(r.actor!.id, browser(r), 'purge', r.body, r.params.ledger),
  );
  app.post('/api/factory-reset', (r) =>
    service.execute(r.actor!.id, browser(r), 'factory', r.body),
  );
  // POST avoids putting the one-time grant in a URL/header or weakening GET's
  // existing contract. The ordinary Origin and session hooks apply unchanged.
  app.post<{ Params: { ledger: string } }>(
    '/api/ledgers/:ledger/backup.json',
    async (r, reply) => {
      const sessionToken = browser(r),
        q = resetBackupSchema.safeParse(r.body);
      if (!q.success) throw new DomainError('invalid_input', 400);
      const backup = await backups.download(r.actor!.id, r.params.ledger, {
        sessionToken,
        backupToken: q.data.backup_token,
      });
      return reply
        .header('cache-control', 'no-store')
        .header('content-type', 'application/json; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="finmichi.json"; filename*=UTF-8''${encodeURIComponent(backupFilename(backup.ledger.name, backup.exportedAt))}`,
        )
        .send(backup);
    },
  );
}
