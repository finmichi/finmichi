// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic ADR-0005 T0–T5 only. Never reads financial files.
import {
  itemService,
  transactionService,
} from '../packages/core/dist/index.js';
export async function seedReport(db, actor, ledger) {
  const service = itemService(db),
    ids = {};
  for (const [key, name, kind, parent, flags] of [
    ['assets', '流動資產', 'asset', null, {}],
    ['cash', '現金', 'asset', 'assets', {}],
    ['bank', '銀行', 'asset', 'assets', {}],
    ['equity', '期初／調整', 'equity', null, {}],
    ['salary', '薪資', 'income', null, { fixed: true }],
    ['interest', '利息收入', 'income', null, { non_operating: true }],
    [
      'expenses',
      '生活支出',
      'expense',
      null,
      { non_operating: true, fixed: true },
    ],
    ['food', '餐費', 'expense', 'expenses', { fixed: true }],
    ['travel', '交通', 'expense', 'expenses', {}],
  ])
    ids[key] = (
      await service.create(actor, ledger, {
        name,
        kind,
        currency: 'TWD',
        parent_id: parent ? ids[parent] : null,
        ...flags,
      })
    ).id;
  const inputs = [
    [
      '2026-09-30',
      [
        ['equity', '-10000'],
        ['cash', '10000'],
      ],
    ],
    [
      '2026-10-01',
      [
        ['cash', '-120'],
        ['food', '120'],
      ],
    ],
    [
      '2026-10-05',
      [
        ['salary', '-35000'],
        ['cash', '35000'],
      ],
    ],
    [
      '2026-10-09',
      [
        ['cash', '-1000'],
        ['food', '600'],
        ['travel', '400'],
      ],
    ],
    [
      '2026-10-10',
      [
        ['interest', '-50'],
        ['bank', '50'],
      ],
    ],
    [
      '2026-11-02',
      [
        ['cash', '-2000'],
        ['bank', '2000'],
      ],
    ],
  ];
  const transactions = [];
  for (const [occurred_on, legs] of inputs)
    transactions.push(
      (
        await transactionService(db).create(actor, ledger, {
          occurred_on,
          memo: '合成 ADR0005',
          entries: legs.map(([key, amount]) => ({ item_id: ids[key], amount })),
        })
      ).id,
    );
  return { ...ids, transactions };
}
