// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parse as parseCsv } from 'csv-parse/sync';
import {
  itemService,
  transactionService,
  queryCsv,
  namedRecordService,
} from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>, cash: string, food: string;
const memo = ' =SUM(1,2)\r\n"合成摘要"';
function parse(text: string): string[][] {
  return parseCsv(text, { bom: true, cast: false }) as string[][];
}
const unsafeMemos = [
  '-1+1',
  '=SUM(A1)',
  '@x',
  '  =SUM(A1)',
  '\u0001=SUM(A1)',
  '-123',
];
const endpoint = (q: Record<string, string> = {}) =>
  `/api/ledgers/${f.ledger}/transactions/export.csv?${new URLSearchParams(q)}`;
beforeAll(async () => {
  f = await fixture('query-csv');
  const items = itemService(f.db);
  cash = (
    await items.create(f.actor, f.ledger, {
      name: '@合成現金',
      kind: 'asset',
      currency: 'TWD',
    })
  ).id;
  food = (
    await items.create(f.actor, f.ledger, {
      name: '合成餐費',
      kind: 'expense',
      currency: 'TWD',
    })
  ).id;
  const payee = await namedRecordService(f.db, 'payees').create(
    f.actor,
    f.ledger,
    { name: '-123' },
  );
  const project = await namedRecordService(f.db, 'projects').create(
    f.actor,
    f.ledger,
    { name: '=SUM(A1)' },
  );
  for (let i = 0; i < 105; i++)
    await transactionService(f.db).create(f.actor, f.ledger, {
      occurred_on: i === 0 ? '2026-10-01' : '2026-10-02',
      memo: i === 0 ? memo : (unsafeMemos[i - 1] ?? '合成其他'),
      invoice_no: i === 0 ? '+ABC' : 'OTHER',
      ...(i === 0 ? { payee_id: payee.id, project_id: project.id } : {}),
      entries: [
        { item_id: cash, amount: '-1000' },
        { item_id: food, amount: '1000' },
      ],
    });
});
afterAll(async () => {
  if (f) await f.close();
});
it('CSV details preserve BOM, RFC quoting and all 105 matching transactions beyond a page', async () => {
  const r = await f.app.inject({ url: endpoint(), headers: f.headers });
  expect(r.statusCode).toBe(200);
  expect(r.rawPayload.subarray(0, 3)).toEqual(Buffer.from([239, 187, 191]));
  expect(r.headers['content-type']).toContain('text/csv');
  expect(r.headers['content-disposition']).toContain('attachment');
  expect(r.headers['cache-control']).toBe('no-store');
  const rows = parse(r.body);
  expect(rows).toHaveLength(106);
  expect(rows[0]).not.toContain('所選科目淨額');
  const row = rows.find((r) => r[0] === '2026-10-01')!;
  expect(row[2]).toBe("'" + memo);
  expect(row[3]).toBe("'+ABC");
  expect(row[4]).toBe("'-123");
  expect(row[5]).toBe("'=SUM(A1)");
  expect(row[6]).toBe('1000.00');
  expect(row[7]).toBe("'@合成現金 → 合成餐費");
});
it('CSV AND filters match details; subtree net and all selected transaction legs are retained', async () => {
  const filters = {
    date_from: '2026-10-01',
    date_to: '2026-10-01',
    item_id: food,
    keyword: 'abc',
    amount_min: '1000',
    amount_max: '1000',
    kind: 'expense',
  };
  const detail = parse(
    await queryCsv(f.db, f.actor, f.ledger, { ...filters, format: 'detail' }),
  );
  expect(detail).toHaveLength(2);
  expect(detail[0]).toContain('所選科目淨額');
  expect(detail[1]![7]).toBe('1000.00');
  const response = await f.app.inject({
    url: endpoint({ ...filters, format: 'entries' }),
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  const rows = parse(response.body);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toEqual([
    '交易 id',
    '日期',
    '科目',
    'kind',
    '原幣金額',
    '幣別',
    '匯率',
    'base_amount',
  ]);
  expect(rows.slice(1).map((r) => r[2])).toEqual(["'@合成現金", '合成餐費']);
  expect(rows[1]![7]).toBe('-1000.00');
  const empty = parse(
    await queryCsv(f.db, f.actor, f.ledger, { keyword: 'no-synthetic-match' }),
  );
  expect(empty).toHaveLength(1);
});
it('CSV owner isolation is 404 even with invalid format; unauthenticated 401 and invalid query 400', async () => {
  for (const q of [{}, { format: 'bad' }, { item_id: cash }])
    expect(
      (await f.app.inject({ url: endpoint(q), headers: f.otherHeaders }))
        .statusCode,
    ).toBe(404);
  expect((await f.app.inject({ url: endpoint() })).statusCode).toBe(401);
  for (const q of [
    { format: 'bad' },
    { limit: '1' },
    { date_from: 'bad' },
    { amount_min: '1001', amount_max: '1000' },
  ])
    expect(
      (await f.app.inject({ url: endpoint(q), headers: f.headers })).statusCode,
    ).toBe(400);
});

it('CSV provenance keeps signed system numbers numeric while every formula-like memo remains text', async () => {
  const response = await f.app.inject({
    url: endpoint({ item_id: cash }),
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  const rows = parse(response.body).slice(1);
  expect(rows).toHaveLength(105);
  expect(rows.every((r) => r[6] === '1000.00' && r[7] === '-1000.00')).toBe(
    true,
  );
  for (const text of unsafeMemos)
    expect(rows.some((r) => r[2] === "'" + text)).toBe(true);
  const entries = parse(
    await queryCsv(f.db, f.actor, f.ledger, { format: 'entries' }),
  ).slice(1);
  expect(entries).toHaveLength(210);
  for (const row of entries)
    for (const index of [4, 6, 7])
      expect(row[index]).toMatch(/^-?\d+(?:\.\d+)?$/);
  expect(entries.some((r) => r[7] === '-1000.00')).toBe(true);
  expect(entries.some((r) => r[2] === "'@合成現金")).toBe(true);
});
