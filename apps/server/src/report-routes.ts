// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance } from 'fastify';
import type { Database } from '@finmichi/db';
import {
  reportService,
  profitLossCsv,
  netWorthFlowCsv,
  accountLedgerCsv,
  budgetReportCsv,
  balanceReportCsv,
  incomeReportCsv,
  categoryReportCsv,
} from '@finmichi/core';
export function reportRoutes(app: FastifyInstance, db: Database) {
  const service = reportService(db),
    base = '/api/ledgers/:ledger/reports';
  type P = { Params: { ledger: string } };
  for (const [name, get, csv] of [
    ['profit-loss', service.profitLoss, profitLossCsv],
    ['net-worth-flow', service.netWorthFlow, netWorthFlowCsv],
    ['account-ledger', service.accountLedger, accountLedgerCsv],
  ] as const) {
    app.get<P>(base + '/' + name, (r) =>
      get(r.actor!.id, r.params.ledger, r.query),
    );
    // Full account export shares the report service inside a read-only repeatable-read snapshot.
    app.get<P>(base + '/' + name + '.csv', async (r, reply) => {
      const report =
        name === 'account-ledger'
          ? await service.accountLedgerAll(
              r.actor!.id,
              r.params.ledger,
              r.query,
            )
          : await get(r.actor!.id, r.params.ledger, r.query);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}.csv"`)
        .header('cache-control', 'no-store')
        .send((csv as (r: typeof report) => string)(report));
    });
  }
  app.get<P>(base + '/cash-forecast', (r) =>
    service.cashForecast(r.actor!.id, r.params.ledger, r.query),
  );
  app.get<P>(base + '/budget-vs-actual', (r) =>
    service.budget(r.actor!.id, r.params.ledger, r.query),
  );
  app.get<P>(base + '/budget-vs-actual.csv', async (r, reply) => {
    const report = await service.budget(r.actor!.id, r.params.ledger, r.query);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        'attachment; filename="budget-vs-actual.csv"',
      )
      .header('cache-control', 'no-store')
      .send(budgetReportCsv(report));
  });
  app.get<P>(base + '/category-statistics', (r) =>
    service.category(r.actor!.id, r.params.ledger, r.query),
  );
  app.get<P>(base + '/category-statistics.csv', async (r, reply) => {
    const report = await service.category(
      r.actor!.id,
      r.params.ledger,
      r.query,
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        'attachment; filename="category-statistics.csv"',
      )
      .header('cache-control', 'no-store')
      .send(categoryReportCsv(report));
  });
  app.get<P>(base + '/income-summary', (r) =>
    service.income(r.actor!.id, r.params.ledger, r.query),
  );
  app.get<P>(base + '/income-summary.csv', async (r, reply) => {
    const report = await service.income(r.actor!.id, r.params.ledger, r.query);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        'attachment; filename="income-summary.csv"',
      )
      .header('cache-control', 'no-store')
      .send(incomeReportCsv(report));
  });
  app.get<P>(base + '/balance-sheet', (r) =>
    service.balance(r.actor!.id, r.params.ledger, r.query),
  );
  app.get<P>(base + '/balance-sheet.csv', async (r, reply) => {
    const report = await service.balance(r.actor!.id, r.params.ledger, r.query);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="balance-sheet.csv"')
      .header('cache-control', 'no-store')
      .send(balanceReportCsv(report));
  });
}
