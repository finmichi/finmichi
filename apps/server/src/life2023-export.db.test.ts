// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { parse } from 'csv-parse/sync';
import { fixture } from '../test/catalog-fixture.js';
import {
  ledgerService,
  itemService,
  namedRecordService,
  transactionService,
  reportService,
  life2023Service,
  queryService,
} from '@finmichi/core';
import { roundHalfUp } from '@finmichi/core/money';
import type {
  Life2023Export,
  ItemChoice,
} from '@finmichi/core/life2023-schemas';
import { life2023Headers } from '@finmichi/core/life2023-schemas';
import type { Item } from '@finmichi/core/catalog-schemas';
let f: Awaited<ReturnType<typeof fixture>>;
const url = (ledger: string, q: Record<string, string> = {}) =>
  `/api/ledgers/${ledger}/transactions/life2023-export?${new URLSearchParams(q)}`;
async function exported(ledger: string, q: Record<string, string> = {}) {
  const r = await f.app.inject({ url: url(ledger, q), headers: f.headers });
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  return r.json<Life2023Export>();
}
async function imported(ledger: string, data: unknown) {
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${ledger}/imports/life2023/confirm`,
    headers: f.headers,
    payload: data,
  });
  expect(r.statusCode).toBe(201);
  return r.json();
}
beforeAll(async () => {
  f = await fixture('life2023-export');
});
afterAll(async () => {
  if (f) await f.close();
});
async function cloneCatalog(source: string, target: string) {
  const service = itemService(f.db),
    items = await service.list(f.actor, source, { include_archived: 'true' }),
    ids = new Map<string, string>();
  async function copy(item: Item): Promise<string> {
    const found = ids.get(item.id);
    if (found) return found;
    const parent = item.parent_id
      ? await copy(items.find((i) => i.id === item.parent_id)!)
      : null;
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/ledgers/${target}/items`,
      headers: f.headers,
      payload: {
        name: item.name,
        kind: item.kind,
        currency: item.currency,
        parent_id: parent,
        non_operating: item.non_operating,
        fixed: item.fixed,
        credit_card: item.credit_card,
        loan: item.loan,
        archived: item.archived,
      },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json<Item>();
    ids.set(item.id, created.id);
    return created.id;
  }
  for (const i of items) await copy(i);
  return ids;
}
function stripMeta<T extends { ledger_id: string; generated_at: string }>(
  report: T,
) {
  const { ledger_id, generated_at, ...rest } = report;
  void ledger_id;
  void generated_at;
  return rest;
}
function normalizeItems<T extends { id: string; parent_id: string | null }>(
  rows: T[],
  names: Map<string, string>,
) {
  return rows
    .map(({ id, parent_id, ...rest }) => ({
      ...rest,
      item: names.get(id),
      parent: parent_id ? names.get(parent_id) : null,
    }))
    .sort((a, b) => String(a.item).localeCompare(String(b.item)));
}
it('ADR0006 rev1.1 round trip preserves transactions, guarded text explicitly and all three SQL reports', async () => {
  const source = f.ledger,
    target = (
      await ledgerService(f.db).create(f.actor, { name: '合成往返目標' })
    ).id,
    items = itemService(f.db),
    ids: Record<string, string> = {};
  const definitions = [
    ['assets', '流動資產', 'asset', null, false, false],
    ['cash', '現金', 'asset', 'assets', false, false],
    ['bank', '銀行', 'asset', 'assets', false, false],
    ['equity', '期初權益', 'equity', null, false, false],
    ['salary', '薪資', 'income', null, false, true],
    ['interest', '利息', 'income', null, true, false],
    ['expenses', '生活支出', 'expense', null, false, false],
    ['food', '餐費', 'expense', 'expenses', false, true],
    ['travel', '旅費', 'expense', 'expenses', true, false],
  ] as const;
  for (const [key, name, kind, parent, non_operating, fixed] of definitions)
    ids[key] = (
      await items.create(f.actor, source, {
        name,
        kind,
        currency: 'TWD',
        parent_id: parent ? ids[parent] : null,
        non_operating,
        fixed,
      })
    ).id;
  const payee = await namedRecordService(f.db, 'payees').create(
      f.actor,
      source,
      { name: '-合成收付人' },
    ),
    project = await namedRecordService(f.db, 'projects').create(
      f.actor,
      source,
      { name: '@合成專案' },
    );
  const samples = [
    ['2026-09-30', 'equity', 'cash', '10000', '合成期初'],
    ['2026-10-01', 'salary', 'bank', '35000', '"合成",逗號\n換行'],
    ['2026-10-02', 'cash', 'food', '720', '=SUM(A1)'],
    ['2026-10-03', 'bank', 'travel', '400', '-123'],
    ['2026-10-04', 'cash', 'bank', '3000', '合成轉帳'],
    ['2026-10-05', 'interest', 'cash', '50', '合成業外'],
    ['2026-10-06', 'food', 'cash', '20', '合成退款'],
  ] as const;
  for (const [date, a, b, amount, memo] of samples)
    await transactionService(f.db).create(f.actor, source, {
      occurred_on: date,
      memo,
      payee_id: payee.id,
      project_id: project.id,
      invoice_no: '+FAKE',
      entries: [
        { item_id: ids[a], amount: '-' + amount },
        { item_id: ids[b], amount },
      ],
    });
  await cloneCatalog(source, target);
  expect(await queryService(f.db).all(f.actor, target, {})).toHaveLength(0);
  const result = await exported(source);
  expect(result.exported_count).toBe(7);
  expect(result.skipped_count).toBe(0);
  expect([...Buffer.from(result.csv).subarray(0, 3)]).toEqual([239, 187, 191]);
  expect(result.csv).toContain('\r\n');
  const rows = parse(result.csv, { bom: true, cast: false }) as string[][];
  expect(rows[0]).toEqual(life2023Headers);
  expect(
    rows.every(
      (r, i) =>
        i === 0 ||
        (/^\d{4}\/\d{2}\/\d{2}$/.test(r[0]!) && /^\d+\.\d{2}$/.test(r[3]!)),
    ),
  ).toBe(true);
  const data = { file_base64: Buffer.from(result.csv).toString('base64') };
  const preview = await life2023Service(f.db).preview(f.actor, target, data);
  expect(preview.importable_count).toBe(7);
  expect(preview.pending_creates.items).toBe(0);
  expect(
    preview.item_groups.every((g) => g.selection?.mode === 'existing'),
  ).toBe(true);
  await imported(target, data);
  const a = await queryService(f.db).all(f.actor, source, {}),
    b = await queryService(f.db).all(f.actor, target, {});
  const tuple = (tx: (typeof a)[number]) => {
    const source = tx.entries.find((e) => e.amount.startsWith('-'))!,
      dest = tx.entries.find((e) => !e.amount.startsWith('-'))!;
    return [
      tx.occurred_on,
      source.item_name,
      dest.item_name,
      roundHalfUp(dest.amount, 2),
    ];
  };
  expect(a.map((t) => JSON.stringify(tuple(t))).sort()).toEqual(
    b.map((t) => JSON.stringify(tuple(t))).sort(),
  );
  expect(b).toHaveLength(a.length);
  for (const original of a) {
    const restored = b.find(
      (t) => JSON.stringify(tuple(t)) === JSON.stringify(tuple(original)),
    )!;
    expect(restored.memo).toBe(
      /^[\s\p{Cc}]*[=+@-]/u.test(original.memo)
        ? "'" + original.memo
        : original.memo,
    );
    expect(restored.invoice_no).toBe("'" + original.invoice_no);
    expect(restored.payee_name).toBe("'" + original.payee_name);
    expect(restored.project_name).toBe("'" + original.project_name);
  }
  const reports = reportService(f.db),
    range = { date_from: '2026-09-01', date_to: '2026-11-30' };
  for (const grain of ['day', 'month', 'quarter', 'year'] as const)
    expect(
      stripMeta(await reports.income(f.actor, target, { ...range, grain })),
    ).toEqual(
      stripMeta(await reports.income(f.actor, source, { ...range, grain })),
    );
  const sourceItems = await items.list(f.actor, source),
    targetItems = await items.list(f.actor, target),
    namesA = new Map(sourceItems.map((i) => [i.id, i.kind + ':' + i.name])),
    namesB = new Map(targetItems.map((i) => [i.id, i.kind + ':' + i.name]));
  const ba = stripMeta(
      await reports.balance(f.actor, source, { as_of: '2026-10-31' }),
    ),
    bb = stripMeta(
      await reports.balance(f.actor, target, { as_of: '2026-10-31' }),
    );
  expect({ ...bb, items: normalizeItems(bb.items, namesB) }).toEqual({
    ...ba,
    items: normalizeItems(ba.items, namesA),
  });
  expect(bb.totals.identity_difference).toBe('0.00');
  for (const kind of ['income', 'expense'])
    for (const non_operating of ['all', 'operating', 'non_operating'])
      for (const fixed of ['all', 'fixed', 'variable']) {
        const q = { ...range, kind, non_operating, fixed },
          ca = stripMeta(await reports.category(f.actor, source, q)),
          cb = stripMeta(await reports.category(f.actor, target, q));
        expect({
          ...cb,
          items: normalizeItems(cb.items, namesB),
          pie: normalizeItems(cb.pie, namesB),
          bars: normalizeItems(cb.bars, namesB),
        }).toEqual({
          ...ca,
          items: normalizeItems(ca.items, namesA),
          pie: normalizeItems(ca.pie, namesA),
          bars: normalizeItems(ca.bars, namesA),
        });
      }
});
it('guarded item name requires explicit mapping back; never strips apostrophe or fuzzy matches', async () => {
  const source = (
      await ledgerService(f.db).create(f.actor, { name: '合成名稱防護來源' })
    ).id,
    target = (
      await ledgerService(f.db).create(f.actor, { name: '合成名稱防護目標' })
    ).id,
    items = itemService(f.db);
  const cash = (
      await items.create(f.actor, source, {
        name: '現金',
        kind: 'asset',
        currency: 'TWD',
      })
    ).id,
    cost = (
      await items.create(f.actor, source, {
        name: '=餐費',
        kind: 'expense',
        currency: 'TWD',
      })
    ).id;
  await transactionService(f.db).create(f.actor, source, {
    occurred_on: '2026-10-17',
    memo: "'本來就有",
    entries: [
      { item_id: cash, amount: '-10' },
      { item_id: cost, amount: '10' },
    ],
  });
  const copied = await cloneCatalog(source, target),
    result = await exported(source);
  expect(result.csv).toContain("'=餐費");
  const input = { file_base64: Buffer.from(result.csv).toString('base64') };
  const preview = await life2023Service(f.db).preview(f.actor, target, input);
  expect(preview.importable_count).toBe(0);
  expect(
    preview.item_groups.find((g) => g.name === "'=餐費")!.selection,
  ).toBeNull();
  const mapped = {
    ...input,
    item_mappings: {
      "destination:'=餐費": {
        mode: 'existing',
        id: copied.get(cost)!,
      } as ItemChoice,
    },
  };
  expect(
    (await life2023Service(f.db).preview(f.actor, target, mapped))
      .importable_count,
  ).toBe(1);
  await imported(target, mapped);
  const restored = await queryService(f.db).all(f.actor, target, {});
  expect(restored[0]!.memo).toBe("'本來就有");
  expect(
    restored[0]!.entries.find((e) => !e.amount.startsWith('-'))!.item_name,
  ).toBe('=餐費');
});
it('same query filters, owner 404, skipped multi-entry and foreign counts and typed numeric/text rules', async () => {
  const ledger = (
      await ledgerService(f.db).create(f.actor, { name: '合成略過與篩選' })
    ).id,
    items = itemService(f.db),
    tx = transactionService(f.db);
  const a = (
      await items.create(f.actor, ledger, {
        name: '合成現金',
        kind: 'asset',
        currency: 'TWD',
      })
    ).id,
    b = (
      await items.create(f.actor, ledger, {
        name: '合成支出',
        kind: 'expense',
        currency: 'TWD',
      })
    ).id,
    usd = (
      await items.create(f.actor, ledger, {
        name: '合成美元',
        kind: 'asset',
        currency: 'USD',
      })
    ).id;
  for (const memo of ['-1+1', '=SUM(A1)', '@x', ' =x', '\t=x', '-123'])
    await tx.create(f.actor, ledger, {
      occurred_on: '2026-10-17',
      memo,
      entries: [
        { item_id: a, amount: '-1000' },
        { item_id: b, amount: '1000' },
      ],
    });
  await tx.create(f.actor, ledger, {
    occurred_on: '2026-10-18',
    memo: '合成多分錄',
    entries: [
      { item_id: a, amount: '-10' },
      { item_id: b, amount: '4' },
      { item_id: b, amount: '6' },
    ],
  });
  await tx.create(f.actor, ledger, {
    occurred_on: '2026-10-19',
    memo: '合成外幣',
    entries: [
      { item_id: usd, amount: '-1', exchange_rate: '32.5' },
      { item_id: a, amount: '32.5' },
    ],
  });
  const result = await exported(ledger);
  expect(result.exported_count).toBe(6);
  expect(result.skipped_count).toBe(2);
  expect(result.skip_reasons).toEqual([
    { code: 'multiple_entries', count: 1 },
    { code: 'foreign_currency', count: 1 },
  ]);
  const rows = (
    parse(result.csv, { bom: true, cast: false }) as string[][]
  ).slice(1);
  expect(rows.every((r) => r[3] === '1000.00')).toBe(true);
  expect(rows.map((r) => r[4]).sort()).toEqual(
    ["'-1+1", "'=SUM(A1)", "'@x", "' =x", "'\t=x", "'-123"].sort(),
  );
  for (const q of [
    { date_from: '2026-10-17', date_to: '2026-10-17' },
    { keyword: 'sum', kind: 'expense' },
    { item_id: b, amount_min: '1000', amount_max: '1000' },
  ]) {
    const filtered = await exported(ledger, q);
    const found = await queryService(f.db).all(f.actor, ledger, q);
    expect(filtered.exported_count).toBe(
      found.filter(
        (t) =>
          t.entries.length === 2 &&
          t.entries.every((e) => e.currency === 'TWD'),
      ).length,
    );
  }
  expect(
    (await f.app.inject({ url: url(ledger), headers: f.otherHeaders }))
      .statusCode,
  ).toBe(404);
  expect((await f.app.inject({ url: url(ledger) })).statusCode).toBe(401);
  expect(
    (
      await f.app.inject({
        url: url(ledger, { item_id: b }),
        headers: f.otherHeaders,
      })
    ).statusCode,
  ).toBe(404);
  const empty = await exported(ledger, { keyword: '不存在' });
  expect(empty.exported_count).toBe(0);
  expect(parse(empty.csv, { bom: true })).toHaveLength(1);
});
