// SPDX-License-Identifier: AGPL-3.0-only
// Entirely synthetic: cross-month travel, JPY/TWD expenses, a refund and a mixed transaction.
import {
  itemService,
  namedRecordService,
  transactionService,
} from '../packages/core/dist/index.js';
export async function seedProjects(db, actor, ledger) {
  const items = itemService(db),
    projects = namedRecordService(db, 'projects'),
    ids = {};
  for (const [key, name, kind, currency, parent] of [
    ['cash', '合成現金', 'asset', 'TWD', null],
    ['bank', '合成銀行', 'asset', 'TWD', null],
    ['yen', '合成日幣', 'asset', 'JPY', null],
    ['expense', '旅程支出', 'expense', 'TWD', null],
    ['food', '旅程餐飲', 'expense', 'TWD', 'expense'],
    ['foreign', '旅程日幣交通', 'expense', 'JPY', 'expense'],
    ['income', '旅程收入', 'income', 'TWD', null],
  ])
    ids[key] = (
      await items.create(actor, ledger, {
        name,
        kind,
        currency,
        parent_id: parent ? ids[parent] : null,
      })
    ).id;
  const trip = await projects.create(actor, ledger, { name: '合成跨月旅遊' }),
    archived = await projects.create(actor, ledger, { name: '合成封存旅遊' }),
    empty = await projects.create(actor, ledger, { name: '合成空白專案' });
  const service = transactionService(db);
  const tx = async (date, project, legs) =>
    service.create(actor, ledger, {
      occurred_on: date,
      project_id: project,
      memo: '合成專案測試',
      entries: legs.map(([item, amount]) => ({
        item_id: ids[item],
        amount,
        ...(['yen', 'foreign'].includes(item) ? { exchange_rate: '0.2' } : {}),
      })),
    });
  await tx('2026-09-30', trip.id, [
    ['cash', '-200'],
    ['food', '200'],
  ]);
  await tx('2026-10-02', trip.id, [
    ['yen', '-5000'],
    ['foreign', '5000'],
  ]);
  await tx('2026-10-03', trip.id, [
    ['foreign', '-500'],
    ['yen', '500'],
  ]);
  await tx('2026-10-04', trip.id, [
    ['income', '-100'],
    ['cash', '100'],
  ]);
  await tx('2026-10-05', trip.id, [
    ['cash', '-50'],
    ['bank', '50'],
  ]);
  await tx('2026-10-06', trip.id, [
    ['cash', '-20'],
    ['food', '120'],
    ['income', '-100'],
  ]);
  await tx('2026-10-07', archived.id, [
    ['cash', '-77'],
    ['food', '77'],
  ]);
  await tx('2026-10-08', null, [
    ['cash', '-999'],
    ['food', '999'],
  ]);
  await projects.update(actor, ledger, archived.id, { archived: true });
  return { ids, trip: trip.id, archived: archived.id, empty: empty.id };
}
