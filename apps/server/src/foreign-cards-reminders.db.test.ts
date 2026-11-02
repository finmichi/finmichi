// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from '../test/catalog-fixture.js';
import {
  ledgerService,
  itemService,
  financeService,
  transactionService,
  reminderService,
  cashForecastService,
  backupService,
  restoreService,
  patService,
  forecastToday,
  depositService,
} from '@finmichi/core';
import { addDays, monthDate } from '@finmichi/core/finance-calendar';
let f: Awaited<ReturnType<typeof fixture>>,
  ledger: string,
  bank: string,
  income: string,
  expense: string,
  card: string;
const today = forecastToday();
beforeAll(async () => {
  f = await fixture('foreign-reminders-' + randomUUID());
});
afterAll(async () => {
  if (f) await f.close();
});
beforeEach(async () => {
  await f.db`DELETE FROM market_fetch_runs`;
  ledger = (
    await ledgerService(f.db).create(f.actor, {
      name: 'Synthetic reminders ' + randomUUID(),
    })
  ).id;
  bank = await item('Bank', 'asset');
  income = await item('Income', 'income');
  expense = await item('Expense', 'expense');
  card = await item('USD card', 'liability', 'USD', { credit_card: true });
});
async function item(
  name: string,
  kind: 'asset' | 'liability' | 'expense' | 'income',
  currency = 'TWD',
  extra = {},
) {
  return (
    await itemService(f.db).create(f.actor, ledger, {
      name,
      kind,
      currency,
      ...extra,
    })
  ).id;
}
const settings = (payment = bank) => ({
  item_id: card,
  statement_day: 1,
  due_day: 20,
  due_month_offset: 1,
  payment_account_id: payment,
  credit_limit: '1000',
});
const list = () => reminderService(f.db).list(f.actor, ledger);
const path = () => `/api/ledgers/${ledger}/reminders`;
async function spend(date: string, amount = '-100') {
  return transactionService(f.db).create(f.actor, ledger, {
    occurred_on: date,
    entries: [
      { item_id: card, amount },
      { item_id: expense, amount: amount.startsWith('-') ? '3200' : '-3200' },
    ],
  });
}
async function deposit(maturity = addDays(today, 7), status = 'active') {
  const id = await item('Deposit ' + randomUUID(), 'asset');
  const d = await depositService(f.db).save(f.actor, ledger, {
    item_id: id,
    bank: 'Synthetic bank',
    principal: '1000',
    annual_rate: '1',
    start_on: monthDate(maturity, -1),
    maturity_on: maturity,
    interest_basis: 'daily',
    payout: 'at_maturity',
    auto_renew: false,
    payout_account_id: bank,
    interest_item_id: income,
    note: '',
  });
  if (status !== 'active')
    await f.db`UPDATE fixed_deposits SET status=${status} WHERE id=${d.id}`;
  return d;
}
const template = () => ({
  memo: 'PRIVATE_REMINDER_MEMO',
  invoice_no: 'PRIVATE_REMINDER_INVOICE',
  payee_id: null,
  project_id: null,
  entries: [
    { item_id: bank, amount: '-10' },
    { item_id: expense, amount: '10' },
  ],
});
async function occurrence(date = today, status = 'pending') {
  const [r] =
    await f.db`INSERT INTO recurring_occurrences(ledger_id,source_rule_id,rule_name,occurs_on,occurred_on,template,status,error_code) VALUES(${ledger},${randomUUID()},'Synthetic',${date},${date},${f.db.json(template())},${status},${status === 'failed' ? 'period_locked' : null}) RETURNING id`;
  return r!.id as string;
}
async function draft(age = 0, status = 'pending') {
  const [r] =
    await f.db`INSERT INTO transaction_drafts(ledger_id,payload,preview,status,created_at,decided_at) VALUES(${ledger},${f.db.json({ ...template(), occurred_on: today })},'{}',${status},now()-make_interval(days=>${age}),${status === 'pending' ? null : new Date()}) RETURNING id`;
  return r!.id as string;
}
async function rowCounts() {
  const tables =
    await f.db`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  return Promise.all(
    tables.map(async (t) => [
      t.tablename,
      (
        await f.db.unsafe('SELECT count(*)::text n FROM "' + t.tablename + '"')
      )[0]!.n,
    ]),
  );
}
it('foreign settings allow same/base currency; third currency and all foreign loan references remain rejected, DB guards too', async () => {
  const usd = await item('USD bank', 'asset', 'USD'),
    eur = await item('EUR bank', 'asset', 'EUR');
  for (const payment of [usd, bank])
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: `/api/ledgers/${ledger}/cards`,
          headers: f.headers,
          payload: settings(payment),
        })
      ).statusCode,
    ).toBe(200);
  const r = await f.app.inject({
    method: 'PUT',
    url: `/api/ledgers/${ledger}/cards`,
    headers: f.headers,
    payload: settings(eur),
  });
  expect(r.json().error).toBe('currency_not_supported');
  await expect(
    f.db`UPDATE credit_card_settings SET payment_account_id=${eur} WHERE item_id=${card}`,
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    f.db`UPDATE items SET currency='EUR' WHERE id=${bank}`,
  ).rejects.toMatchObject({ code: '23514' });
  const loan = await item('USD loan', 'liability', 'USD', { loan: true });
  await expect(
    financeService(f.db).saveLoan(f.actor, ledger, {
      item_id: loan,
      principal: '100',
      annual_rate: '0',
      term_months: 2,
      first_payment_on: today,
      method: 'annuity',
      payment_account_id: bank,
      interest_item_id: expense,
    }),
  ).rejects.toMatchObject({ code: 'currency_not_supported' });
});
it('statements, utilization and current debt use original USD, not 3200 TWD base; forecast caps before conversion', async () => {
  await financeService(f.db).saveCard(f.actor, ledger, settings());
  await spend(monthDate(today, -2, 2));
  await f.db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES(${ledger},${today},'USD','TWD',32.12345)`;
  // Ledger precedence is tested in an isolated currency; here explicit market snapshot wins when present.
  await f.db`INSERT INTO market_fx_rates(rate_date,currency,source,spot_buy,spot_sell) VALUES(${today},'USD','bot',31,32.5) ON CONFLICT(rate_date,currency,source) DO UPDATE SET spot_buy=31,spot_sell=32.5`;
  const c = (await financeService(f.db).cards(f.actor, ledger)).cards[0]!;
  expect(c.current_balance).toBe('100.000000');
  expect(c.bills[0]!.amount_due).toBe('100.000000');
  expect(c.utilization).toBe('10.0000000000');
  expect(c.payment_quote).toMatchObject({ source: 'bot', rate: '32.5000' });
  const before = await rowCounts(),
    r = await cashForecastService(f.db).forecast(f.actor, ledger, {}),
    after = await rowCounts();
  expect(after).toEqual(before);
  const events = r.events.filter((e) => e.source_type === 'card');
  expect(events).toHaveLength(1);
  expect(events[0]!.amount).toBe('-3250.00');
  expect(events[0]!.memo).toContain('估算（匯率 32.5000');
  expect(r.warnings).toEqual([]);
  await spend(today, '100');
  expect(
    (
      await cashForecastService(f.db).forecast(f.actor, ledger, {})
    ).events.filter((e) => e.source_type === 'card'),
  ).toEqual([]);
});
it('missing FX gives warning and no 1:1; ledger fallback and same-currency foreign payment exclusion', async () => {
  const rare = await item('X currency card', 'liability', 'XZZ', {
    credit_card: true,
  });
  card = rare;
  await financeService(f.db).saveCard(f.actor, ledger, settings());
  await spend(monthDate(today, -2, 2));
  let r = await cashForecastService(f.db).forecast(f.actor, ledger, {});
  expect(r.events).toHaveLength(0);
  expect(r.warnings).toEqual([
    { source_type: 'card', item_id: card, code: 'fx_rate_missing' },
  ]);
  await f.db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES(${ledger},${addDays(today, -2)},'XZZ','TWD',30.12345)`;
  const c = (await financeService(f.db).cards(f.actor, ledger)).cards[0]!;
  expect(c.payment_quote).toMatchObject({
    rate: '30.1235',
    source: 'ledger',
    rate_date: addDays(today, -2),
  });
  r = await cashForecastService(f.db).forecast(f.actor, ledger, {});
  expect(r.events[0]!.amount).toBe('-3012.35');
  const same = await item('X currency bank', 'asset', 'XZZ');
  await financeService(f.db).saveCard(f.actor, ledger, settings(same));
  r = await cashForecastService(f.db).forecast(f.actor, ledger, {});
  expect(r.events).toEqual([]);
  expect(r.warnings).toEqual([]);
});
it('deposit boundaries include overdue, T and T+7, exclude T+8 and settled; loan excludes overdue, zero and day4', async () => {
  for (const d of [-22, 0, 7, 8]) await deposit(addDays(today, d));
  await deposit(today, 'matured');
  for (const d of [-1, 0, 3, 4]) {
    const loan = await item('Loan ' + d, 'liability', 'TWD', { loan: true });
    await financeService(f.db).saveLoan(f.actor, ledger, {
      item_id: loan,
      principal: '100',
      annual_rate: '0',
      term_months: 1,
      first_payment_on: addDays(today, d),
      method: 'annuity',
      payment_account_id: bank,
      interest_item_id: expense,
    });
  }
  const zero = await item('Zero loan', 'liability', 'TWD', { loan: true });
  await financeService(f.db).saveLoan(f.actor, ledger, {
    item_id: zero,
    principal: '0.06',
    annual_rate: '0',
    term_months: 12,
    first_payment_on: today,
    method: 'annuity',
    payment_account_id: bank,
    interest_item_id: expense,
  });
  const r = await list();
  expect(
    r.items.filter((x) => x.type === 'deposit').map((x) => x.date),
  ).toEqual([-22, 0, 7].map((d) => addDays(today, d)));
  expect(r.items[0]!.detail).toBe('已到期 22 天，待處理');
  expect(r.items.filter((x) => x.type === 'loan').map((x) => x.date)).toEqual([
    today,
    addDays(today, 3),
  ]);
});
it('recurring uses edited dates, pending/failed only; drafts exclude expired/processed; no payload leaks', async () => {
  await occurrence(addDays(today, -2));
  await occurrence(today, 'failed');
  await occurrence(addDays(today, 1));
  await occurrence(today, 'skipped');
  await occurrence(today, 'posted');
  const id = await occurrence(addDays(today, 10));
  await f.db`UPDATE recurring_occurrences SET occurred_on=${today} WHERE id=${id}`;
  await draft();
  await draft(14);
  await draft(0, 'approved');
  const r = await list();
  expect(r.items.filter((x) => x.type === 'recurring')).toHaveLength(3);
  expect(r.items.filter((x) => x.type === 'draft')).toHaveLength(1);
  expect(JSON.stringify(r)).not.toMatch(/PRIVATE_REMINDER|payload|template/);
  await reminderService(f.db).saveSettings(f.actor, ledger, {
    recurring_days: 1,
  });
  expect(
    (await list()).items.filter((x) => x.type === 'recurring'),
  ).toHaveLength(4);
});
it('same-day type order, read upserts, stale fingerprint ignored, payload/date changes become unread, all and cleanup', async () => {
  const d = await deposit(today),
    o = await occurrence(),
    dr = await draft();
  let r = await list();
  expect(r.items.map((x) => x.type)).toEqual(['deposit', 'recurring', 'draft']);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: path() + '/read',
        headers: f.headers,
        payload: {
          items: [{ key: r.items[0]!.key, fingerprint: '0'.repeat(64) }],
        },
      })
    ).json(),
  ).toEqual({ marked: 0 });
  expect(
    (await reminderService(f.db).markRead(f.actor, ledger, { all: true }))
      .marked,
  ).toBe(3);
  expect((await list()).unread_count).toBe(0);
  await f.db`UPDATE fixed_deposits SET principal=1001 WHERE id=${d.id}`;
  await f.db`UPDATE recurring_occurrences SET occurred_on=${addDays(today, -1)} WHERE id=${o}`;
  await f.db`UPDATE transaction_drafts SET payload=jsonb_set(payload,'{memo}','"changed"') WHERE id=${dr}`;
  r = await list();
  expect(r.unread_count).toBe(3);
  await reminderService(f.db).markRead(f.actor, ledger, { all: true });
  await f.db`INSERT INTO reminder_reads(ledger_id,key,fingerprint,read_at) SELECT ${ledger},'deposit:'||gen_random_uuid()::text,repeat('a',64),now()-interval '1 day' FROM generate_series(1,1002)`;
  await reminderService(f.db).markRead(f.actor, ledger, { all: true });
  expect(
    (
      await f.db`SELECT count(*)::int n FROM reminder_reads WHERE ledger_id=${ledger}`
    )[0]!.n,
  ).toBe(1000);
  expect((await list()).unread_count).toBe(0);
});
it('settings validate ranges; disabled types absent; read-only GET has zero writes; owner/Origin boundaries', async () => {
  await deposit();
  await occurrence();
  await draft();
  const before = await rowCounts();
  const read = await f.app.inject({ url: path(), headers: f.headers });
  expect(read.statusCode).toBe(200);
  expect(await rowCounts()).toEqual(before);
  for (const [method, url] of [
    ['GET', path()],
    ['GET', path() + '/settings'],
    ['PUT', path() + '/settings'],
    ['POST', path() + '/read'],
  ] as const) {
    const r = await f.app.inject({
      method,
      url,
      headers: f.otherHeaders,
      ...(method === 'PUT'
        ? { payload: {} }
        : method === 'POST'
          ? { payload: { all: true } }
          : {}),
    });
    expect(r.statusCode).toBe(404);
  }
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: path() + '/read',
        headers: { ...f.headers, origin: 'https://other.invalid' },
        payload: { all: true },
      })
    ).statusCode,
  ).toBe(403);
  for (const patch of [
    { deposit_days: 61 },
    { market_trading_days: 0 },
    { card_days: -1 },
  ])
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: path() + '/settings',
          headers: f.headers,
          payload: patch,
        })
      ).statusCode,
    ).toBe(400);
  await reminderService(f.db).saveSettings(f.actor, ledger, {
    deposit_enabled: false,
    card_enabled: false,
    loan_enabled: false,
    recurring_enabled: false,
    draft_enabled: false,
    market_enabled: false,
  });
  expect((await list()).items).toEqual([]);
});
it('market reminders use configured trading-day threshold, account flags and blocked source', async () => {
  await f.db`DELETE FROM market_fetch_runs`;
  await f.db`DELETE FROM market_calendar`;
  const old = addDays(today, -10);
  for (const source of ['bot', 'twse', 'tpex'])
    await f.db`INSERT INTO market_fetch_runs(source,status,data_date) VALUES(${source},'success',${old})`;
  expect(
    (await list()).items.filter((r) => r.type === 'market').map((r) => r.key),
  ).toEqual(['market:bot']);
  await item('Stock', 'asset', 'TWD', { securities: true });
  expect((await list()).items.filter((r) => r.type === 'market')).toHaveLength(
    3,
  );
  await f.db`UPDATE market_fetch_runs SET data_date=${today}`;
  expect((await list()).items.filter((r) => r.type === 'market')).toHaveLength(
    0,
  );
  await f.db`UPDATE market_fetch_runs SET status='blocked_by_source' WHERE source='bot'`;
  expect(
    (await list()).items.filter((r) => r.type === 'market').map((r) => r.key),
  ).toEqual(['market:bot']);
  await reminderService(f.db).saveSettings(f.actor, ledger, {
    market_enabled: false,
  });
  expect((await list()).items).toEqual([]);
});
it('v7 full/structure restore foreign card settings and reminder keys; missing UUID reads skipped', async () => {
  await financeService(f.db).saveCard(f.actor, ledger, settings());
  const d = await deposit(today);
  await occurrence();
  await draft();
  await reminderService(f.db).saveSettings(f.actor, ledger, {
    deposit_days: 9,
  });
  await reminderService(f.db).markRead(f.actor, ledger, { all: true });
  await f.db`INSERT INTO reminder_reads(ledger_id,key,fingerprint) VALUES(${ledger},${'deposit:' + randomUUID()},${'b'.repeat(64)})`;
  const b = await backupService(f.db).download(f.actor, ledger);
  expect(b.schemaVersion).toBe(9);
  for (const mode of ['full', 'structure']) {
    const r = await restoreService(f.db).confirm(f.actor, b, {
      mode,
      name: 'Synthetic restored ' + randomUUID(),
    });
    const copy = await backupService(f.db).download(f.actor, r.ledger.id);
    expect(copy.tables.reminder_settings[0]!.deposit_days).toBe(9);
    expect(copy.tables.credit_card_settings[0]!.item_id).toBe(
      r.id_map.items[card],
    );
    if (mode === 'structure') expect(copy.tables.reminder_reads).toEqual([]);
    else {
      expect(
        copy.tables.reminder_reads.some(
          (x) => x.key === 'deposit:' + r.id_map.fixed_deposits[d.id],
        ),
      ).toBe(true);
      expect(
        copy.tables.reminder_reads.some((x) => x.key.startsWith('draft:')),
      ).toBe(false);
      expect(
        (await reminderService(f.db).list(f.actor, r.ledger.id)).items.find(
          (x) => x.type === 'deposit',
        )!.read,
      ).toBe(true);
    }
  }
});
it('official MCP SDK reminders equals REST, token scope enforced, no mark-read tool and safe audit', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js'),
    { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await deposit();
  await occurrence();
  await draft();
  const pat = await patService(f.db).create(f.actor, {
    scope: 'read',
    expires_in_days: 1,
    ledger_ids: [ledger],
    mask_text: true,
  });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 }),
    client = new Client({ name: 'synthetic-reminders', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(address + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + pat.token } },
      }),
    );
    const response = await client.callTool({
      name: 'get_report',
      arguments: { ledger_id: ledger, report: 'reminders' },
    });
    expect(response.isError).not.toBe(true);
    const text = (response.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual(await list());
    expect(text).not.toContain('PRIVATE_REMINDER');
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
      'mark_reminders_read',
    );
    expect(
      (
        await client.callTool({
          name: 'get_report',
          arguments: { ledger_id: f.ledger, report: 'reminders' },
        })
      ).isError,
    ).toBe(true);
    const logs =
      await f.db`SELECT row_to_json(a)::text body FROM audit_logs a WHERE user_id=${f.actor}`;
    for (const r of logs) {
      expect(r.body).not.toMatch(
        /PRIVATE_REMINDER|fingerprint|template|payload/,
      );
      expect(r.body).not.toContain(pat.token);
    }
  } finally {
    await client.close();
  }
});
it('card reminder includes overdue and T+days boundary, excludes next day, caps cumulative statements', async () => {
  const cards = [];
  for (const offset of [-2, 0, 7, 8]) {
    const due = addDays(today, offset),
      id = await item('Boundary card ' + offset, 'liability', 'TWD', {
        credit_card: true,
      });
    cards.push(id);
    await financeService(f.db).saveCard(f.actor, ledger, {
      ...settings(),
      item_id: id,
      due_day: Number(due.slice(-2)),
    });
    await transactionService(f.db).create(f.actor, ledger, {
      occurred_on: monthDate(due, -2, 2),
      entries: [
        { item_id: id, amount: '-100' },
        { item_id: expense, amount: '100' },
      ],
    });
  }
  const rows = (await list()).items.filter((r) => r.type === 'card');
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.date)).toEqual(
    [-2, 0, 7].map((d) => addDays(today, d)),
  );
  expect(rows.map((r) => r.key.split(':')[1])).toEqual(cards.slice(0, 3));
});
it('market threshold is inclusive and uses actual calendar; no relevant items means no market alerts', async () => {
  const date = addDays(today, -4);
  await f.db`DELETE FROM market_calendar`;
  await f.db`DELETE FROM market_fetch_runs`;
  for (const d of [-3, -2, -1])
    await f.db`INSERT INTO market_calendar(date,market,is_trading_day,source) VALUES(${addDays(today, d)},'TWSE',true,'twse')`;
  await f.db`INSERT INTO market_fetch_runs(source,status,data_date) VALUES('twse','success',${date})`;
  await item('Threshold stock', 'asset', 'TWD', { securities: true });
  expect(
    (await list()).items.find((r) => r.key === 'market:twse')?.detail,
  ).toBe('行情落後 3 個交易日');
  await reminderService(f.db).saveSettings(f.actor, ledger, {
    market_trading_days: 4,
  });
  expect((await list()).items.filter((r) => r.type === 'market')).toHaveLength(
    0,
  );
  const blank = await ledgerService(f.db).create(f.actor, {
    name: 'Synthetic no-market ' + randomUUID(),
  });
  expect((await reminderService(f.db).list(f.actor, blank.id)).items).toEqual(
    [],
  );
});
