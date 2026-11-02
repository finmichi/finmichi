// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  budgetService,
  itemService,
  recurringService,
  reportService,
  transactionService,
} from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>;
const date = '2026-10-10';
const tx = (cash: string, target: string, amount = '10') => ({
  occurred_on: date,
  entries: [
    { item_id: cash, amount: '-' + amount },
    { item_id: target, amount },
  ],
});
beforeAll(async () => {
  f = await fixture('postable');
});
afterAll(async () => {
  if (f) await f.close();
});
async function item(
  name: string,
  kind = 'expense',
  parent_id: string | null = null,
) {
  return itemService(f.db).create(f.actor, f.ledger, {
    name,
    kind,
    currency: 'TWD',
    parent_id,
  });
}
it('HTTP rejects new parent posting, permits unchanged historical fields and still isolates owners', async () => {
  const root = await item('Synthetic historical parent'),
    cash = await item('Synthetic bank', 'asset');
  const prior = await transactionService(f.db).create(
    f.actor,
    f.ledger,
    tx(cash.id, root.id),
  );
  const middle = await item('Synthetic middle', 'expense', root.id);
  await item('Synthetic leaf', 'expense', middle.id);
  const url = `/api/ledgers/${f.ledger}/transactions`;
  const rejected = await f.app.inject({
    method: 'POST',
    url,
    headers: f.headers,
    payload: tx(cash.id, root.id),
  });
  expect(rejected.statusCode).toBe(400);
  expect(rejected.json()).toEqual({ error: 'parent_item_not_postable' });
  const saved = await f.app.inject({
    method: 'PATCH',
    url: url + '/' + prior.id,
    headers: f.headers,
    payload: {
      memo: 'Synthetic metadata',
      entries: tx(cash.id, root.id, '20').entries,
    },
  });
  expect(saved.statusCode).toBe(200);
  const duplicated = await f.app.inject({
    method: 'PATCH',
    url: url + '/' + prior.id,
    headers: f.headers,
    payload: {
      entries: [
        { item_id: cash.id, amount: '-20' },
        { item_id: root.id, amount: '10' },
        { item_id: root.id, amount: '10' },
      ],
    },
  });
  expect(duplicated.json().error).toBe('parent_item_not_postable');
  const changed = await f.app.inject({
    method: 'PATCH',
    url: url + '/' + prior.id,
    headers: f.headers,
    payload: tx(cash.id, middle.id),
  });
  expect(changed.json().error).toBe('parent_item_not_postable');
  for (const method of ['GET', 'PATCH'] as const) {
    const r = await f.app.inject({
      method,
      url: url + '/' + prior.id,
      headers: f.otherHeaders,
      ...(method === 'PATCH' ? { payload: { memo: 'Synthetic' } } : {}),
    });
    expect(r.statusCode).toBe(404);
  }
  const q = await f.app.inject({
    url: url + '?item_id=' + root.id,
    headers: f.headers,
  });
  expect(q.statusCode).toBe(200);
  expect(q.json().items).toHaveLength(1);
  expect(q.json().items[0].transaction_amount).toBe('20.000000');
  await itemService(f.db).update(f.actor, f.ledger, root.id, {
    archived: true,
  });
  const archived = await f.app.inject({
    url: url + '?item_id=' + root.id,
    headers: f.headers,
  });
  expect(archived.json().items).toHaveLength(1);
  const again = await f.app.inject({
    method: 'PATCH',
    url: url + '/' + prior.id,
    headers: f.headers,
    payload: { memo: 'Synthetic unchanged archived fields' },
  });
  expect(again.statusCode).toBe(200);
});
it('an archived child does not prevent new posting to its unarchived parent', async () => {
  const root = await item('Synthetic parent of archive'),
    child = await item('Synthetic archived child', 'expense', root.id),
    cash = await item('Synthetic second cash', 'asset');
  await itemService(f.db).update(f.actor, f.ledger, child.id, {
    archived: true,
  });
  await expect(
    transactionService(f.db).create(f.actor, f.ledger, tx(cash.id, root.id)),
  ).resolves.toHaveProperty('id');
});
it('rules preserve unchanged historical fields but new rules reject parent/archive', async () => {
  const parent = await item('Synthetic recurring'),
    cash = await item('Synthetic recurring bank', 'asset');
  const input = {
    name: 'Synthetic rule',
    frequency: 'monthly',
    day_of_month: 1,
    start_on: '2026-10-01',
    template: { entries: tx(cash.id, parent.id).entries },
  };
  const svc = recurringService(f.db),
    old = await svc.save(f.actor, f.ledger, input);
  await item('Synthetic recurring child', 'expense', parent.id);
  await expect(
    svc.save(f.actor, f.ledger, { ...input, name: 'Synthetic rename' }, old.id),
  ).resolves.toHaveProperty('id', old.id);
  await expect(svc.save(f.actor, f.ledger, input)).rejects.toMatchObject({
    code: 'parent_item_not_postable',
  });
  await itemService(f.db).update(f.actor, f.ledger, parent.id, {
    archived: true,
  });
  await expect(
    svc.save(f.actor, f.ledger, input, old.id),
  ).resolves.toHaveProperty('id', old.id);
  await expect(svc.save(f.actor, f.ledger, input)).rejects.toMatchObject({
    code: 'archived_resource',
  });
});
it('parent and child budgets remain independently editable and roll up unchanged', async () => {
  const parent = await item('Synthetic budget root'),
    child = await item('Synthetic budget child', 'expense', parent.id);
  const url = `/api/ledgers/${f.ledger}/budgets`;
  for (const [id, amount] of [
    [parent.id, '100'],
    [child.id, '50'],
  ]) {
    const r = await f.app.inject({
      method: 'PUT',
      url,
      headers: f.headers,
      payload: { year: 2026, item_id: id, months: [{ month: 10, amount }] },
    });
    expect(r.statusCode).toBe(200);
  }
  const report = await reportService(f.db).budget(f.actor, f.ledger, {
    year: 2026,
    grain: 'month',
    kind: 'expense',
    non_operating: 'all',
    fixed: 'all',
  });
  expect(
    report.periods[9]!.items.find((i) => i.id === parent.id),
  ).toMatchObject({
    budget_own: '100.00',
    budget_rollup: '150.00',
    actual_rollup: '0.00',
  });
  await expect(
    budgetService(f.db).save(f.actor, f.ledger, {
      year: 2026,
      item_id: parent.id,
      months: [{ month: 10, amount: '120' }],
    }),
  ).resolves.toBeDefined();
});
it('historical Life2023 import and JSON restore retain parent entries without changing query totals', async () => {
  const { life2023Service, backupService, restoreService, queryService } =
    await import('@finmichi/core');
  const { life2023Headers } = await import('@finmichi/core/life2023-schemas');
  const cash = await item('Synthetic CSV cash', 'asset'),
    parent = await item('Synthetic CSV root');
  await item('Synthetic CSV child', 'expense', parent.id);
  const cells = [
    life2023Headers,
    [
      '2026/10/11',
      cash.name,
      parent.name,
      '12.34',
      'Synthetic history',
      '',
      '',
      '',
    ],
  ];
  const file_base64 = Buffer.from(
    cells
      .map((row) =>
        row.map((v) => '"' + v.replaceAll('"', '""') + '"').join(','),
      )
      .join('\r\n') + '\r\n',
  ).toString('base64');
  const imported = await life2023Service(f.db).confirm(f.actor, f.ledger, {
    file_base64,
  });
  expect(imported.imported_count).toBe(1);
  const before = await queryService(f.db).search(f.actor, f.ledger, {
    item_id: parent.id,
  });
  expect(before.totals.count).toBe(1);
  expect(before.totals.selected_net_amount).toBe('12.340000');
  const backup = await backupService(f.db).download(f.actor, f.ledger);
  const result = await restoreService(f.db).confirm(f.actor, backup, {
    name: 'Synthetic parent restore',
  });
  const [newParent] =
    await f.db`SELECT id FROM items WHERE ledger_id=${result.ledger.id} AND name=${parent.name}`;
  const after = await queryService(f.db).search(f.actor, result.ledger.id, {
    item_id: String(newParent!.id),
  });
  expect(after.totals).toEqual(before.totals);
  expect(
    after.items.map((t) => [
      t.occurred_on,
      t.transaction_amount,
      t.selected_net_amount,
    ]),
  ).toEqual(
    before.items.map((t) => [
      t.occurred_on,
      t.transaction_amount,
      t.selected_net_amount,
    ]),
  );
  await expect(
    transactionService(f.db).create(
      f.actor,
      result.ledger.id,
      tx(cash.id, String(newParent!.id)),
    ),
  ).rejects.toMatchObject({ code: 'item_ledger_mismatch' });
});
