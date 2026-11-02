// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ledgerService,
  itemService,
  transactionService,
  financeService,
  recurringService,
  cashForecastService,
} from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
let f: Awaited<ReturnType<typeof fixture>>,
  ledger: string,
  bank: string,
  other: string,
  expense: string,
  equity: string;
const today = '2026-10-06';
beforeAll(async () => {
  f = await fixture('cash-forecast');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(today + 'T04:00:00Z'));
});
afterAll(async () => {
  vi.useRealTimers();
  if (f) await f.close();
});
beforeEach(async () => {
  ledger = (
    await ledgerService(f.db).create(f.actor, {
      name: '合成資金預估 ' + randomUUID(),
    })
  ).id;
  bank = await item('銀行', 'asset');
  other = await item('現金', 'asset');
  expense = await item('支出', 'expense');
  equity = await item('期初', 'equity');
  await tx(today, bank, '2000', equity);
});
async function item(
  name: string,
  kind: 'asset' | 'liability' | 'expense' | 'equity',
  extra = {},
) {
  return (
    await itemService(f.db).create(f.actor, ledger, {
      name,
      kind,
      currency: 'TWD',
      ...extra,
    })
  ).id;
}
async function tx(
  date: string,
  id: string,
  amount: string,
  counter = expense,
  memo = '合成預估摘要',
) {
  return transactionService(f.db).create(f.actor, ledger, {
    occurred_on: date,
    memo,
    entries: [
      { item_id: id, amount },
      {
        item_id: counter,
        amount: amount.startsWith('-') ? amount.slice(1) : '-' + amount,
      },
    ],
  });
}
const read = (input: unknown = {}) =>
  cashForecastService(f.db).forecast(f.actor, ledger, input);
const template = (amount = '-100') => ({
  memo: '合成週期摘要',
  payee_id: null,
  project_id: null,
  invoice_no: '',
  entries: [
    { item_id: bank, amount },
    { item_id: expense, amount: amount.slice(1) },
  ],
});
async function rule(extra = {}) {
  return recurringService(f.db).save(f.actor, ledger, {
    name: '合成週期 ' + randomUUID(),
    frequency: 'monthly',
    day_of_month: 31,
    start_on: '2026-10-01',
    template: template(),
    ...extra,
  });
}
async function occurrence(
  r: string,
  occurs_on: string,
  status = 'pending',
  occurred_on = occurs_on,
  amount = '-100',
) {
  const id = randomUUID();
  await f.db`INSERT INTO recurring_occurrences(id,ledger_id,rule_id,source_rule_id,rule_name,occurs_on,occurred_on,template,status,error_code) VALUES(${id},${ledger},${r},${r},'合成規則',${occurs_on},${occurred_on},${f.db.json(template(amount))},${status},${status === 'failed' ? 'locked_period' : null})`;
  return id;
}
it('includes today for N days, starts with booked-today balance and uses strict end-of-day threshold on combined accounts', async () => {
  await tx(today, other, '-500', bank);
  await tx('2026-10-07', bank, '-100');
  await tx('2026-11-04', bank, '-200'); // day 30
  await tx('2026-11-05', bank, '-900'); // excluded day 31
  const r = await read({ horizon_days: 30, threshold: '1700' });
  expect(r.as_of).toBe(today);
  expect(r.days).toHaveLength(30);
  expect(r.date_to).toBe('2026-11-04');
  expect(r.opening_total).toBe('2000.00');
  expect(r.days[0]!.total).toBe('2000.00');
  expect(r.days.at(-1)!.total).toBe('1700.00');
  expect(r.first_below_threshold).toBeNull();
  expect((await read({ threshold: '1700.01' })).first_below_threshold).toBe(
    '2026-11-04',
  );
  expect(r.days[0]!.balances.find((b) => b.account_id === other)!.balance).toBe(
    '-500.00',
  ); // per-account deficit does not trigger total threshold
});
it('checks daily net rather than intermediate intraday dip; future transaction grouped once per account', async () => {
  await tx('2026-10-07', bank, '-2500');
  await tx('2026-10-07', bank, '2600');
  const r = await read();
  expect(r.first_below_threshold).toBeNull();
  expect(r.days[1]!.total).toBe('2100.00');
  expect(r.events.filter((e) => e.source_type === 'transaction')).toHaveLength(
    2,
  );
});
it('projects from next_on, clamps month ends and respects end_on, inactive and weekly intervals', async () => {
  const monthly = await rule({ end_on: '2027-02-28' });
  await f.db`UPDATE recurring_rules SET next_on='2026-10-31' WHERE id=${monthly.id}`;
  const weekly = await rule({
    frequency: 'weekly',
    day_of_month: null,
    weekday: 2,
    interval: 2,
    start_on: today,
    end_on: '2026-11-03',
  });
  await rule({ active: false });
  const r = await read({ horizon_days: 180 });
  expect(
    r.events
      .filter((e) => e.source_id.startsWith(monthly.id))
      .map((e) => e.date),
  ).toEqual([
    '2026-10-31',
    '2026-11-30',
    '2026-12-31',
    '2027-01-31',
    '2027-02-28',
  ]);
  expect(
    r.events
      .filter((e) => e.source_id.startsWith(weekly.id))
      .map((e) => e.date),
  ).toEqual(['2026-10-06', '2026-10-20', '2026-11-03']);
});
it('occurrence key blocks rule projection for every status, pending/failed use edited snapshot/date and overdue becomes today', async () => {
  const r = await rule();
  await f.db`UPDATE recurring_rules SET next_on='2026-10-31' WHERE id=${r.id}`;
  const edited = await occurrence(
    r.id,
    '2026-10-31',
    'pending',
    '2026-10-08',
    '-333',
  );
  const overdueFailed = await occurrence(
    r.id,
    '2026-09-30',
    'failed',
    '2026-10-01',
    '-50',
  );
  const overduePending = await occurrence(
    r.id,
    '2026-08-31',
    'pending',
    '2026-09-29',
    '-20',
  );
  await occurrence(r.id, '2026-11-30', 'posted');
  await occurrence(r.id, '2026-12-31', 'skipped');
  const report = await read({ horizon_days: 180 });
  expect(report.events.find((e) => e.source_id === edited)).toMatchObject({
    date: '2026-10-08',
    amount: '-333.00',
    source_type: 'occurrence',
  });
  expect(
    report.events.find((e) => e.source_id === overdueFailed),
  ).toMatchObject({ date: today, amount: '-50.00' });
  expect(
    report.events
      .filter((e) => e.source_type === 'recurring')
      .map((e) => e.date),
  ).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  expect(
    report.events.find((e) => e.source_id === overduePending),
  ).toMatchObject({ date: today, amount: '-20.00', source_type: 'occurrence' });
  expect(report.days[0]!.total).toBe('1930.00');
});
it('pending remains forecast after deleting or disabling rule; future posted tx counted only through transaction', async () => {
  const r = await rule({ active: false });
  const o = await occurrence(r.id, '2026-10-31');
  const future = await tx('2026-10-10', bank, '-25');
  await occurrence(r.id, '2026-09-30', 'posted');
  await f.db`UPDATE recurring_occurrences SET transaction_id=${future.id} WHERE source_rule_id=${r.id} AND occurs_on='2026-09-30'`;
  await f.db`UPDATE recurring_occurrences SET rule_id=NULL WHERE id=${o}`;
  const result = await read();
  expect(
    result.events.filter((e) => e.source_type === 'occurrence'),
  ).toHaveLength(1);
  expect(
    result.events.filter((e) => e.source_type === 'transaction'),
  ).toHaveLength(1);
});
it('offset-one cumulative card debt flows only 1000 on 10/20, adds unclosed consumption to next statement', async () => {
  const card = await item('合成卡', 'liability', { credit_card: true });
  await financeService(f.db).saveCard(f.actor, ledger, {
    item_id: card,
    credit_limit: null,
    statement_day: 5,
    due_day: 20,
    due_month_offset: 1,
    payment_account_id: bank,
  });
  await tx('2026-08-10', card, '-1000');
  await tx(today, card, '-200');
  const r = await read({ horizon_days: 90 });
  const events = r.events.filter((e) => e.source_type === 'card');
  expect(events).toEqual([
    expect.objectContaining({ date: '2026-10-20', amount: '-1000.00' }),
    expect.objectContaining({ date: '2026-12-20', amount: '-200.00' }),
  ]);
});
it.each([
  ['fully repaid', '500', '0.000000', []],
  ['partially repaid', '300', '200.000000', ['-200.00']],
  ['overpaid', '600', '-100.000000', []],
])(
  'caps late-paid historical card bills at current debt: %s',
  async (_, payment, balance, amounts) => {
    const card = await item('逾期補繳合成卡', 'liability', {
      credit_card: true,
    });
    await financeService(f.db).saveCard(f.actor, ledger, {
      item_id: card,
      credit_limit: null,
      statement_day: 5,
      due_day: 20,
      due_month_offset: 0,
      payment_account_id: bank,
    });
    await tx('2026-08-10', card, '-500');
    await tx('2026-09-25', card, payment, bank);
    const cards = await financeService(f.db).cards(f.actor, ledger, today);
    expect(cards.cards[0]!.current_balance).toBe(balance);
    expect(cards.cards[0]!.bills).toContainEqual(
      expect.objectContaining({ due_on: '2026-09-20', unpaid: '500.000000' }),
    );
    const r = await read({ horizon_days: 90 });
    expect(
      r.events.filter((e) => e.source_type === 'card').map((e) => e.amount),
    ).toEqual(amounts);
    expect(
      r.events
        .filter((e) => e.source_type === 'card')
        .every((e) => e.date === today),
    ).toBe(true);
  },
);
it('unclosed card consumption falls on next unclosed statement due date, overdue card debt clamps to today', async () => {
  const card = await item('卡', 'liability', { credit_card: true });
  await financeService(f.db).saveCard(f.actor, ledger, {
    item_id: card,
    credit_limit: null,
    statement_day: 5,
    due_day: 20,
    due_month_offset: 0,
    payment_account_id: bank,
  });
  await tx('2026-07-01', card, '-100');
  await tx(today, card, '-20');
  const r = await read({ horizon_days: 60 });
  expect(
    r.events
      .filter((e) => e.source_type === 'card')
      .map((e) => [e.date, e.amount]),
  ).toEqual([
    [today, '-100.00'],
    ['2026-11-20', '-20.00'],
  ]);
});
it('loan projects nonzero future payments only, selected payment accounts only; zero-payment periods absent', async () => {
  const loan = await item('小額貸款', 'liability', { loan: true });
  await financeService(f.db).saveLoan(f.actor, ledger, {
    item_id: loan,
    principal: '0.06',
    annual_rate: '0',
    term_months: 12,
    first_payment_on: '2025-12-06',
    method: 'annuity',
    payment_account_id: bank,
    interest_item_id: expense,
  });
  const r = await read({ horizon_days: 60 });
  expect(
    r.events
      .filter((e) => e.source_type === 'loan')
      .map((e) => [e.date, e.amount]),
  ).toEqual([['2026-11-06', '-0.06']]);
  expect(
    (await read({ accounts: [other], horizon_days: 60 })).events,
  ).toHaveLength(0);
});
it('excludes foreign/archive/loan assets by default and counts only selected legs', async () => {
  const foreign = await item('美元', 'asset', { currency: 'USD' }),
    archived = await item('封存', 'asset'),
    loanAsset = await item('非預設資產', 'asset', { loan: true });
  await itemService(f.db).update(f.actor, ledger, archived, { archived: true });
  await tx('2026-10-10', bank, '-100', other);
  const r = await read({ accounts: [bank, foreign] });
  expect(r.accounts.map((a) => a.id)).toEqual([bank]);
  expect(r.days[4]!.total).toBe('1900.00');
  expect(r.events).toHaveLength(1);
  const ids = (await read()).accounts.map((a) => a.id);
  expect(ids).not.toContain(foreign);
  expect(ids).not.toContain(archived);
  expect(ids).not.toContain(loanAsset);
});
it('strict HTTP input, owner isolation and foreign account lookups return clear errors', async () => {
  const url = `/api/ledgers/${ledger}/reports/cash-forecast`;
  for (const query of [
    '?horizon_days=31',
    '?threshold=1e3',
    '?threshold=0.001',
    '?unknown=true',
    '?accounts=bad',
  ])
    expect(
      (await f.app.inject({ url: url + query, headers: f.headers })).statusCode,
    ).toBe(400);
  expect(
    (await f.app.inject({ url, headers: f.otherHeaders })).statusCode,
  ).toBe(404);
  expect(
    (
      await f.app.inject({
        url: url + '?accounts=' + randomUUID(),
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(404);
  for (const n of [30, 60, 90, 180, 366]) {
    const r = await f.app.inject({
      url: url + '?horizon_days=' + n,
      headers: f.headers,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().days).toHaveLength(n);
  }
});
async function snapshot() {
  const tables = await f.db<
    { tablename: string }[]
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const rows = [];
  for (const t of tables) {
    if (!/^[a-z_0-9]+$/.test(t.tablename)) throw new Error('invalid table');
    const [r] = await f.db.unsafe(
      `SELECT count(*)::text n,md5(coalesce(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),'')) hash FROM "${t.tablename}" t`,
    );
    rows.push([t.tablename, r]);
  }
  return rows;
}
it('template decimal precision is preserved without truncation in events and daily sums', async () => {
  const r = await rule({ active: false });
  await occurrence(r.id, today, 'pending', today, '-0.005');
  const result = await read();
  expect(result.events[0]!.amount).toBe('-0.005');
  expect(result.days[0]!.total).toBe('1999.995');
});
it('failed template with excessive scale is rejected instead of silently rescaled', async () => {
  const r = await rule({ active: false });
  await occurrence(r.id, today, 'failed', today, '-0.0000001');
  await expect(read()).rejects.toMatchObject({
    code: 'invalid_money_entry',
    statusCode: 400,
  });
});
it('UUID account spelling is case-insensitive and duplicate spellings are rejected', async () => {
  expect(
    (await read({ accounts: [bank.toUpperCase()] })).accounts.map((a) => a.id),
  ).toEqual([bank]);
  await expect(
    read({ accounts: [bank, bank.toUpperCase()] }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
});
it('core repeatable-read snapshot leaves every table byte-identical, including audit and recurring schedules', async () => {
  await rule();
  const before = await snapshot();
  await read({ horizon_days: 366 });
  expect(await snapshot()).toEqual(before);
});
