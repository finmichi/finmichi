// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  itemService,
  transactionService,
  financeService,
  backupService,
  restoreService,
  backupPayloadSha256,
} from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>,
  card: string,
  loan: string,
  bank: string,
  expense: string;
beforeAll(async () => {
  f = await fixture('finance');
  const s = itemService(f.db);
  async function item(
    name: string,
    kind: 'liability' | 'asset' | 'expense',
    flags = {},
  ) {
    return (
      await s.create(f.actor, f.ledger, {
        name,
        kind,
        currency: 'TWD',
        ...flags,
      })
    ).id;
  }
  card = await item('合成信用卡', 'liability', { credit_card: true });
  loan = await item('合成貸款', 'liability', { loan: true });
  bank = await item('合成繳款銀行', 'asset');
  expense = await item('合成利息', 'expense');
});
afterAll(async () => {
  if (f) await f.close();
});
const path = (type: string) => `/api/ledgers/${f.ledger}/${type}`;
const cardInput = () => ({
  item_id: card,
  statement_day: 31,
  due_day: 5,
  due_month_offset: 1,
  payment_account_id: bank,
  credit_limit: '10000.00',
});
const loanInput = () => ({
  item_id: loan,
  principal: '1200000.00',
  annual_rate: '2.100000',
  term_months: 240,
  first_payment_on: '2027-01-31',
  method: 'annuity',
  payment_account_id: bank,
  interest_item_id: expense,
});
it('HTTP card settings enforce rev1.1 schedule and store decimals as strings', async () => {
  for (const [statement_day, due_day] of [
    [28, 31],
    [31, 1],
    [15, 15],
  ]) {
    const r = await f.app.inject({
      method: 'PUT',
      url: path('cards'),
      headers: f.headers,
      payload: { ...cardInput(), statement_day, due_day, due_month_offset: 0 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_card_schedule');
  }
  for (const due_month_offset of [0, 1]) {
    const r = await f.app.inject({
      method: 'PUT',
      url: path('cards'),
      headers: f.headers,
      payload: {
        ...cardInput(),
        statement_day: 27,
        due_day: 28,
        due_month_offset,
      },
    });
    expect(r.statusCode, r.body).toBe(200);
  }
  const r = await f.app.inject({
    method: 'PUT',
    url: path('cards'),
    headers: f.headers,
    payload: cardInput(),
  });
  expect(r.statusCode, r.body).toBe(200);
});
it('credit statement uses cumulative liability and only post-close debit payments within due date; preserves overpayment', async () => {
  const tx = transactionService(f.db);
  async function add(date: string, amount: string) {
    await tx.create(f.actor, f.ledger, {
      occurred_on: date,
      entries: [
        { item_id: card, amount },
        {
          item_id: bank,
          amount: amount.startsWith('-') ? amount.slice(1) : '-' + amount,
        },
      ],
    });
  }
  await add('2027-01-15', '-1000');
  await add('2027-02-28', '-200');
  await add('2027-03-01', '1300');
  await add('2027-03-02', '-50');
  await add('2027-03-06', '10');
  const r = await financeService(f.db).cards(f.actor, f.ledger, '2027-03-10');
  const c = r.cards[0]!,
    b = c.bills.find((b) => b.to === '2027-02-28')!;
  expect(b).toMatchObject({
    from: '2027-02-01',
    to: '2027-02-28',
    due_on: '2027-03-05',
    amount_due: '1200.000000',
    paid: '1300.000000',
    unpaid: '-100.000000',
  });
  expect(c.bills).toHaveLength(12);
  expect(c.current_balance).toBe('-60.000000');
});
it('due-soon reminder uses only positive unpaid and inclusive seven-day window', async () => {
  const r = await financeService(f.db).cards(f.actor, f.ledger, '2027-03-01');
  expect(r.due_soon).toHaveLength(0);
  const earlier = await financeService(f.db).cards(
    f.actor,
    f.ledger,
    '2027-02-28',
  );
  expect(earlier.due_soon).toHaveLength(1);
  expect(earlier.due_soon[0]!.unpaid).toBe('1200.000000');
});
it('loan HTTP settings/schedule/recalculation are exact; preview does not write', async () => {
  const r = await f.app.inject({
    method: 'PUT',
    url: path('loans'),
    headers: f.headers,
    payload: loanInput(),
  });
  expect(r.statusCode, r.body).toBe(200);
  await transactionService(f.db).create(f.actor, f.ledger, {
    occurred_on: '2027-01-01',
    entries: [
      { item_id: loan, amount: '-1200000' },
      { item_id: bank, amount: '1200000' },
    ],
  });
  const [before] = await f.db`SELECT count(*)::int n FROM audit_logs`;
  const v = await financeService(f.db).loans(f.actor, f.ledger, '2027-02-01');
  expect(v.loans[0]!.schedule).toHaveLength(240);
  expect(v.loans[0]!.recalculation).toEqual({
    principal: '1200000.00',
    term_months: 239,
    first_payment_on: '2027-02-01',
  });
  expect(v.loans[0]!.actual_balance).toBe('1200000.000000');
  const [after] = await f.db`SELECT count(*)::int n FROM audit_logs`;
  expect(after!.n).toBe(before!.n);
  const saved = await f.app.inject({
    method: 'PUT',
    url: path('loans'),
    headers: f.headers,
    payload: { ...loanInput(), ...v.loans[0]!.recalculation },
  });
  expect(saved.statusCode).toBe(200);
});
it('invalid principal/rate/period/kind and cross-owner endpoints are rejected', async () => {
  for (const changes of [
    { principal: '0' },
    { principal: '0.001' },
    { annual_rate: '100.000001' },
    { term_months: 601 },
    { item_id: bank },
    { payment_account_id: expense },
  ]) {
    const r = await f.app.inject({
      method: 'PUT',
      url: path('loans'),
      headers: f.headers,
      payload: { ...loanInput(), ...changes },
    });
    expect(r.statusCode, r.body).toBe(400);
  }
  for (const type of ['cards', 'loans']) {
    const read = await f.app.inject({
      url: path(type),
      headers: f.otherHeaders,
    });
    expect(read.statusCode).toBe(404);
    const write = await f.app.inject({
      method: 'PUT',
      url: path(type),
      headers: f.otherHeaders,
      payload: type === 'cards' ? cardInput() : loanInput(),
    });
    expect(write.statusCode).toBe(404);
  }
  const foreign = await itemService(f.db).create(f.actor, f.ledger, {
    name: '合成外帳本占位',
    kind: 'asset',
    currency: 'TWD',
  });
  const [otherLedger] =
    await f.db`INSERT INTO ledgers(owner_id,name,base_currency) VALUES(${f.actor},'合成第二帳本','TWD') RETURNING id`;
  const otherItem = await itemService(f.db).create(f.actor, otherLedger!.id, {
    name: '合成外帳本金流',
    kind: 'asset',
    currency: 'TWD',
  });
  await expect(
    financeService(f.db).saveCard(f.actor, f.ledger, {
      ...cardInput(),
      payment_account_id: otherItem.id,
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    f.db`UPDATE items SET kind='expense' WHERE id=${bank}`,
  ).rejects.toMatchObject({ code: '23514' });
  expect(foreign.id).toBeTruthy();
});
it('v3 full and structure remap every settings reference and retain string precision', async () => {
  const b = await backupService(f.db).download(f.actor, f.ledger);
  expect(b.schemaVersion).toBe(9);
  expect(b.counts.credit_card_settings).toBe(1);
  expect(b.counts.loan_settings).toBe(1);
  for (const mode of ['full', 'structure']) {
    const r = await restoreService(f.db).confirm(f.actor, b, {
      mode,
      name: '合成金融設定還原' + mode,
    });
    const copy = await backupService(f.db).download(f.actor, r.ledger.id);
    const ids = r.id_map.items;
    expect(copy.tables.credit_card_settings[0]).toEqual({
      ...b.tables.credit_card_settings[0],
      ledger_id: r.ledger.id,
      item_id: ids[card],
      payment_account_id: ids[bank],
    });
    expect(copy.tables.loan_settings[0]).toEqual({
      ...b.tables.loan_settings[0],
      ledger_id: r.ledger.id,
      item_id: ids[loan],
      payment_account_id: ids[bank],
      interest_item_id: ids[expense],
    });
    expect(copy.counts.transactions).toBe(
      mode === 'structure' ? 0 : b.counts.transactions,
    );
  }
  const bad = structuredClone(b);
  bad.tables.loan_settings[0]!.interest_item_id =
    '00000000-0000-4000-8000-000000000001';
  bad.payloadSha256 = backupPayloadSha256(bad.tables);
  await expect(
    restoreService(f.db).confirm(f.actor, bad),
  ).rejects.toMatchObject({ code: 'reference_invalid' });
});
it('legacy v2 and v1 backups restore with empty card/loan settings', async () => {
  const b = await backupService(f.db).download(f.actor, f.ledger);
  const old = JSON.parse(JSON.stringify(b));
  delete old.tables.credit_card_settings;
  delete old.tables.loan_settings;
  delete old.counts.credit_card_settings;
  delete old.counts.loan_settings;
  for (const table of [
    'securities',
    'security_trades',
    'manual_prices',
    'income_codes',
    'dividends',
    'dividend_components',
    'reminder_settings',
    'reminder_reads',
    'fixed_deposits',
    'deposit_postings',
  ]) {
    delete old.tables[table];
    delete old.counts[table];
  }
  for (const row of old.tables.items) delete row.securities;
  old.schemaVersion = 2;
  old.format = 'life-ledger';
  old.payloadSha256 = backupPayloadSha256(old.tables);
  for (const version of [2, 1]) {
    old.schemaVersion = version;
    if (version === 1)
      for (const t of ['recurring_rules', 'recurring_occurrences', 'budgets']) {
        delete old.tables[t];
        delete old.counts[t];
      }
    old.payloadSha256 = backupPayloadSha256(old.tables);
    const r = await restoreService(f.db).confirm(f.actor, old, {
      name: '合成舊版金融設定' + version,
    });
    const copy = await backupService(f.db).download(f.actor, r.ledger.id);
    expect(copy.tables.credit_card_settings).toEqual([]);
    expect(copy.tables.loan_settings).toEqual([]);
  }
});
it('rev1.11 accepts foreign card but rejects unsupported payment and foreign loans with explicit currency error; backup refuses invalid references', async () => {
  const is = itemService(f.db),
    usdCard = await is.create(f.actor, f.ledger, {
      name: '合成美元卡',
      kind: 'liability',
      currency: 'USD',
      credit_card: true,
    }),
    usdLoan = await is.create(f.actor, f.ledger, {
      name: '合成美元貸款',
      kind: 'liability',
      currency: 'USD',
      loan: true,
    }),
    usdBank = await is.create(f.actor, f.ledger, {
      name: '合成美元銀行',
      kind: 'asset',
      currency: 'USD',
    }),
    usdExpense = await is.create(f.actor, f.ledger, {
      name: '合成美元利息',
      kind: 'expense',
      currency: 'USD',
    });
  for (const [type, body] of [
    ['cards', { ...cardInput(), payment_account_id: usdBank.id }],
    ['loans', { ...loanInput(), item_id: usdLoan.id }],
    ['loans', { ...loanInput(), payment_account_id: usdBank.id }],
    ['loans', { ...loanInput(), interest_item_id: usdExpense.id }],
  ] as const) {
    const r = await f.app.inject({
      method: 'PUT',
      url: path(type),
      headers: f.headers,
      payload: body,
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toBe('currency_not_supported');
  }
  expect(usdCard.currency).toBe('USD');
  const b = await backupService(f.db).download(f.actor, f.ledger);
  b.tables.credit_card_settings[0]!.payment_account_id = usdBank.id;
  b.payloadSha256 = backupPayloadSha256(b.tables);
  await expect(restoreService(f.db).confirm(f.actor, b)).rejects.toMatchObject({
    code: 'reference_invalid',
  });
  await expect(
    f.db`UPDATE items SET currency='USD' WHERE id=${bank}`,
  ).rejects.toMatchObject({ code: '23514' });
});
it('delete only removes settings and audits never contain financial content', async () => {
  const [before] =
    await f.db`SELECT count(*)::int n FROM transactions WHERE ledger_id=${f.ledger}`;
  for (const [type, id] of [
    ['cards', card],
    ['loans', loan],
  ]) {
    const r = await f.app.inject({
      method: 'DELETE',
      url: path(type!) + ('/' + id),
      headers: f.headers,
    });
    expect(r.statusCode, r.body).toBe(204);
  }
  const [after] =
    await f.db`SELECT count(*)::int n FROM transactions WHERE ledger_id=${f.ledger}`;
  expect(after!.n).toBe(before!.n);
  const logs =
    await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} AND action IN('card.update','card.delete','loan.update','loan.delete')`;
  expect(new Set(logs.map((r) => r.action))).toEqual(
    new Set(['card.update', 'card.delete', 'loan.update', 'loan.delete']),
  );
  expect(JSON.stringify(logs)).not.toMatch(
    /1200000|2\.100000|合成信用卡|principal|cookie|amount/,
  );
});
