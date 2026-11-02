// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { parse } from 'csv-parse/sync';
import {
  itemService,
  ledgerService,
  transactionService,
  reportService,
  sessionService,
} from '@finmichi/core';
import type { BalanceReport } from '@finmichi/core/report-schemas';
import { fixture } from '../test/catalog-fixture.js';
import { seedReport } from '../../../scripts/report-fixture.mjs';
let f: Awaited<ReturnType<typeof fixture>>,
  ids: Awaited<ReturnType<typeof seedReport>>;
const path = (suffix = '') =>
  `/api/ledgers/${f.ledger}/reports/balance-sheet${suffix}`;
async function get(as_of: string) {
  const r = await f.app.inject({
    url: path() + '?' + new URLSearchParams({ as_of }),
    headers: f.headers,
  });
  expect(r.statusCode).toBe(200);
  return r.json<BalanceReport>();
}
beforeAll(async () => {
  f = await fixture('report-balance');
  ids = await seedReport(f.db, f.actor, f.ledger);
});
afterAll(async () => {
  if (f) await f.close();
});
it('ADR0005 T0–T5 as_of identity, historical periods and transfer preserve net worth', async () => {
  const oct = await get('2026-10-31');
  expect(oct.totals).toEqual({
    assets: '43930.00',
    liabilities: '0.00',
    net_worth: '43930.00',
    equity: '10000.00',
    net_income: '33930.00',
    identity_difference: '0.00',
    is_balanced: true,
  });
  expect(oct.items.find((i) => i.id === ids.cash)?.book_amount).toBe(
    '43880.00',
  );
  expect(oct.items.find((i) => i.id === ids.bank)?.book_amount).toBe('50.00');
  const root = oct.items.find((i) => i.id === ids.assets)!;
  expect(root.own_book_amount).toBe('0.00');
  expect(root.book_amount).toBe('43930.00');
  const nov = await get('2026-11-30');
  expect(nov.totals).toEqual(oct.totals);
  expect(nov.items.find((i) => i.id === ids.cash)?.book_amount).toBe(
    '41880.00',
  );
  expect(nov.items.find((i) => i.id === ids.bank)?.book_amount).toBe('2050.00');
  const initial = await get('2026-09-30');
  expect(initial.totals.net_worth).toBe('10000.00');
  expect(initial.totals.equity).toBe('10000.00');
  expect(initial.totals.net_income).toBe('0.00');
  const empty = await get('2026-09-29');
  expect(empty.totals.assets).toBe('0.00');
  expect(empty.totals.is_balanced).toBe(true);
  expect(oct.as_of).toBe('2026-10-31');
  expect(typeof oct.generated_at).toBe('string');
  expect(oct.base_currency).toBe('TWD');
});
it('SQL owner-scoped function agrees with API; cross-user HTTP/core 404 before invalid parameters', async () => {
  const r = await get('2026-10-31');
  const [direct] =
    await f.db`SELECT report_balance_sheet(${f.actor},${f.ledger},'2026-10-31'::date) AS report`;
  expect(direct!.report.totals).toEqual(r.totals);
  const other = (await sessionService(f.db, ['owner', 'stranger']).authenticate(
    f.otherHeaders.cookie.slice(8),
  ))!.id;
  expect(
    (
      await f.db`SELECT report_balance_sheet(${other},${f.ledger},'2026-10-31'::date) AS report`
    )[0]!.report,
  ).toBeNull();
  for (const suffix of ['', '.csv']) {
    expect(
      (
        await f.app.inject({
          url: path(suffix) + '?as_of=bad',
          headers: f.otherHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await f.app.inject({ url: path(suffix) + '?as_of=2026-10-31' }))
        .statusCode,
    ).toBe(401);
  }
  await expect(
    reportService(f.db).balance(other, f.ledger, { as_of: 'bad' }),
  ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
  for (const q of [
    '',
    'as_of=2026-02-30',
    'as_of=2026-10-31&date_from=2026-01-01',
  ])
    expect(
      (await f.app.inject({ url: path() + '?' + q, headers: f.headers }))
        .statusCode,
    ).toBe(400);
});
it('mixed-currency tree keeps historical books and per-currency original balances; liability flags follow kind', async () => {
  const ledger = (
      await ledgerService(f.db).create(f.actor, { name: '合成外幣資產負債' })
    ).id,
    items = itemService(f.db);
  const cash = (
    await items.create(f.actor, ledger, {
      name: '合成現金根',
      kind: 'asset',
      currency: 'TWD',
      credit_card: true,
    })
  ).id;
  const usd = (
    await items.create(f.actor, ledger, {
      name: '=合成美元',
      kind: 'asset',
      currency: 'USD',
      parent_id: null,
    })
  ).id;
  const liability = (
    await items.create(f.actor, ledger, {
      name: '合成卡債',
      kind: 'liability',
      currency: 'USD',
      credit_card: true,
      loan: true,
    })
  ).id;
  const equity = (
    await items.create(f.actor, ledger, {
      name: '合成權益',
      kind: 'equity',
      currency: 'TWD',
    })
  ).id;
  const expense = (
    await items.create(f.actor, ledger, {
      name: '合成支出',
      kind: 'expense',
      currency: 'TWD',
    })
  ).id;
  const tx = transactionService(f.db);
  for (const entries of [
    [
      { item_id: equity, amount: '-10000' },
      { item_id: cash, amount: '10000' },
    ],
    [
      { item_id: cash, amount: '-3250' },
      { item_id: usd, amount: '100', exchange_rate: '32.5' },
    ],
    [
      { item_id: usd, amount: '-10', exchange_rate: '34' },
      { item_id: expense, amount: '340' },
    ],
    [
      { item_id: liability, amount: '-10', exchange_rate: '32.5' },
      { item_id: cash, amount: '325' },
    ],
  ])
    await tx.create(f.actor, ledger, { occurred_on: '2026-10-01', entries });
  // Preserve a historical posting on the root before attaching its child.
  await items.update(f.actor, ledger, usd, { parent_id: cash });
  await f.db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES (${ledger},'2026-10-31','USD','TWD',999)`;
  const r = await reportService(f.db).balance(f.actor, ledger, {
    as_of: '2026-10-31',
  });
  expect(r.totals).toEqual({
    assets: '9985.00',
    liabilities: '325.00',
    net_worth: '9660.00',
    equity: '10000.00',
    net_income: '-340.00',
    identity_difference: '0.00',
    is_balanced: true,
  });
  const account = r.items.find((i) => i.id === usd)!;
  expect(account.book_amount).toBe('2910.00');
  expect(account.own_original_amount).toBe('90.000000');
  const root = r.items.find((i) => i.id === cash)!;
  expect(root.kind).toBe('asset');
  expect(root.book_amount).toBe('9985.00');
  expect(root.original_balances).toEqual([
    { currency: 'TWD', original_amount: '7075.000000', book_amount: '7075.00' },
    { currency: 'USD', original_amount: '90.000000', book_amount: '2910.00' },
  ]);
  expect(r.items.find((i) => i.id === liability)?.own_original_amount).toBe(
    '-10.000000',
  );
  const csv = await f.app.inject({
    url: `/api/ledgers/${ledger}/reports/balance-sheet.csv?as_of=2026-10-31`,
    headers: f.headers,
  });
  const rows = parse(csv.body, { bom: true, cast: false }) as string[][];
  expect(rows.some((r) => r[3] === "'=合成美元")).toBe(true);
  expect(rows.some((r) => r[3] === '合成卡債' && r[8] === '-10.000000')).toBe(
    true,
  );
});
it('CSV BOM and numeric totals survive parser; archived historic balances remain', async () => {
  await itemService(f.db).update(f.actor, f.ledger, ids.cash, {
    archived: true,
  });
  const r = await get('2026-10-31');
  expect(r.items.find((i) => i.id === ids.cash)?.archived).toBe(true);
  expect(r.totals.assets).toBe('43930.00');
  const response = await f.app.inject({
    url: path('.csv') + '?as_of=2026-10-31',
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  expect([...response.rawPayload.subarray(0, 3)]).toEqual([239, 187, 191]);
  expect(response.headers['content-type']).toContain('text/csv');
  const rows = parse(response.body, { bom: true, cast: false }) as string[][];
  expect(rows.some((r) => r[3] === '淨值' && r[5] === '43930.00')).toBe(true);
  expect(response.body).toContain('\r\n');
});
