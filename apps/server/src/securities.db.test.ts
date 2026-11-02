// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fixture } from '../test/catalog-fixture.js';
import { itemService, ledgerService, securityService } from '@finmichi/core';
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture('stocks-' + randomUUID());
});
afterAll(async () => {
  if (f) await f.close();
});
async function setup(base = 'TWD') {
  const l = await ledgerService(f.db).create(f.actor, {
    name: 'Synthetic stock ' + randomUUID(),
    base_currency: base,
  });
  const items = itemService(f.db);
  const mk = (name: string, kind: string, extra = {}) =>
    items.create(f.actor, l.id, { name, kind, currency: base, ...extra });
  const bank = await mk('Synthetic cash', 'asset'),
    gain = await mk('Synthetic investment gain', 'income', {
      non_operating: true,
    }),
    fee = await mk('Synthetic investment fee', 'expense', {
      non_operating: true,
    });
  if (base !== 'TWD') return { l, bank, gain, fee, holding: null, s: null };
  const holding = await mk('Synthetic shares', 'asset', { securities: true });
  const s = await securityService(f.db).create(f.actor, l.id, {
    symbol: '9999A',
    name: '合成股票',
    market: 'TWSE',
    kind: 'stock',
    item_id: holding.id,
  });
  return { l, bank, gain, fee, holding, s };
}
type Scope = Awaited<ReturnType<typeof setup>>;
function trade(c: Scope, extra: Record<string, unknown> = {}) {
  return {
    trade_type: 'buy',
    trade_date: '2026-01-02',
    quantity: '100',
    price: '10',
    fee: '0',
    tax: '0',
    settlement_item_id: c.bank.id,
    expense_item_id: c.fee.id,
    gain_item_id: c.gain.id,
    ...extra,
  };
}
async function preview(c: Scope, operation: string, t?: unknown, id?: string) {
  return f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${c.l.id}/securities/${c.s!.id}/trade-preview`,
    headers: f.headers,
    payload: {
      operation,
      ...(t ? { trade: t } : {}),
      ...(id ? { trade_id: id } : {}),
    },
  });
}
async function apply(c: Scope, t: unknown, operation = 'create', id?: string) {
  const p = await preview(c, operation, t, id);
  expect(p.statusCode, p.body).toBe(200);
  const r = await f.app.inject({
    method: operation === 'create' ? 'POST' : 'PUT',
    url: `/api/ledgers/${c.l.id}/securities/${c.s!.id}/trades${id ? '/' + id : ''}`,
    headers: f.headers,
    payload: {
      trade: t,
      preview_hash: p.json().preview_hash,
      confirm_recalculation: true,
    },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const golden = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/core/test/fixtures/securities/oracle.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  cases: {
    name: string;
    input: Record<string, unknown>[];
    expected: Record<string, string>[];
  }[];
};
for (const scenario of golden.cases.slice(0, 7))
  it('HTTP→DB independent Decimal: ' + scenario.name, async () => {
    const c = await setup();
    for (let i = 0; i < scenario.input.length; i++) {
      const row = scenario.input[i]!,
        t = {
          ...row,
          trade_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
          settlement_item_id: c.bank.id,
          expense_item_id: c.fee.id,
          gain_item_id: c.gain.id,
        };
      const saved = await apply(c, t),
        [dbrow] =
          await f.db`SELECT position_quantity::text,position_cost::text,cost_removed::text,realized_gain::text FROM security_trades WHERE id=${saved.trade_id}`;
      const e = scenario.expected[i]!;
      expect(dbrow).toEqual({
        position_quantity: e.quantity_after,
        position_cost: e.cost_after,
        cost_removed: e.cost_removed,
        realized_gain: e.realized_gain,
      });
    }
    const [bad] =
      await f.db`SELECT count(*)::int AS n FROM (SELECT e.transaction_id FROM transaction_entries e WHERE ledger_id=${c.l.id} GROUP BY e.transaction_id HAVING sum(base_amount)<>0) x`;
    expect(bad!.n).toBe(0);
  });
it('backdated buy rewrites cost/gain and preserves actual cash/fee rows', async () => {
  const c = await setup();
  await apply(c, trade(c));
  const sell = await apply(
    c,
    trade(c, {
      trade_type: 'sell',
      trade_date: '2026-01-03',
      price: '20',
      fee: '1',
      tax: '1',
    }),
  );
  const [sold] =
    await f.db`SELECT transaction_id FROM security_trades WHERE id=${sell.trade_id}`;
  const actual =
    await f.db`SELECT id,item_id,amount::text,entry_position FROM transaction_entries WHERE transaction_id=${sold!.transaction_id} AND item_id IN(${c.bank.id},${c.fee.id}) ORDER BY entry_position`;
  const p = await preview(
    c,
    'create',
    trade(c, { trade_date: '2026-01-01', price: '30' }),
  );
  expect(p.statusCode, p.body).toBe(200);
  expect(p.json().recalculations).toMatchObject([
    {
      old_cost: '1000.00',
      new_cost: '2000.00',
      old_gain: '998.00',
      new_gain: '-2.00',
    },
  ]);
  const no = await f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${c.l.id}/securities/${c.s!.id}/trades`,
    headers: f.headers,
    payload: {
      trade: trade(c, { trade_date: '2026-01-01', price: '30' }),
      preview_hash: p.json().preview_hash,
    },
  });
  expect(no.statusCode).toBe(409);
  expect(no.json().error).toBe('recalculation_confirmation_required');
  await apply(c, trade(c, { trade_date: '2026-01-01', price: '30' }));
  expect(
    await f.db`SELECT id,item_id,amount::text,entry_position FROM transaction_entries WHERE transaction_id=${sold!.transaction_id} AND item_id IN(${c.bank.id},${c.fee.id}) ORDER BY entry_position`,
  ).toEqual(actual);
  const [r] =
    await f.db`SELECT cost_removed::text,realized_gain::text FROM security_trades WHERE id=${sell.trade_id}`;
  expect(r).toEqual({ cost_removed: '2000.00', realized_gain: '-2.00' });
  expect(
    (
      await f.db`SELECT action FROM audit_logs WHERE user_id=${f.actor} AND action='security.recalculate'`
    ).length,
  ).toBeGreaterThan(0);
});
it('generic transaction guards and owner isolation', async () => {
  const c = await setup();
  const saved = await apply(c, trade(c));
  const [r] =
    await f.db`SELECT transaction_id FROM security_trades WHERE id=${saved.trade_id}`;
  const url = `/api/ledgers/${c.l.id}/transactions/${r!.transaction_id}`;
  for (const method of ['PATCH', 'DELETE'] as const) {
    const res = await f.app.inject({
      method,
      url,
      headers: f.headers,
      ...(method === 'PATCH' ? { payload: { memo: 'Synthetic changed' } } : {}),
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe('security_trade_managed');
  }
  const post = await f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${c.l.id}/transactions`,
    headers: f.headers,
    payload: {
      occurred_on: '2026-01-01',
      entries: [
        { item_id: c.holding!.id, amount: '1' },
        { item_id: c.bank.id, amount: '-1' },
      ],
    },
  });
  expect(post.statusCode).toBe(400);
  expect(post.json().error).toBe('security_item_requires_trade');
  for (const path of [
    `/api/ledgers/${c.l.id}/securities`,
    `/api/ledgers/${c.l.id}/securities/${c.s!.id}`,
  ]) {
    const x = await f.app.inject({
      method: 'GET',
      url: path,
      headers: f.otherHeaders,
    });
    expect(x.statusCode).toBe(404);
  }
});
it('closing blocks affected dates, but prior closed trades do not block a new unlocked trade', async () => {
  const c = await setup();
  await apply(c, trade(c));
  await ledgerService(f.db).setLock(f.actor, c.l.id, {
    locked_until: '2026-01-02',
  });
  await apply(c, trade(c, { trade_date: '2026-01-03' }));
  const p = await preview(c, 'create', trade(c, { trade_date: '2026-01-01' }));
  expect(p.statusCode, p.body).toBe(409);
  expect(p.json().error).toBe('period_locked');
  expect(p.json().details.affected_dates).toContain('2026-01-01');
});
it('TWD-only creation, flags, manual prices and trades', async () => {
  const c = await setup('USD');
  await expect(
    itemService(f.db).create(f.actor, c.l.id, {
      name: 'Synthetic foreign shares',
      kind: 'asset',
      currency: 'USD',
      securities: true,
    }),
  ).rejects.toMatchObject({
    code: 'securities_require_twd_ledger',
    statusCode: 400,
  });
  await expect(
    securityService(f.db).create(f.actor, c.l.id, {
      symbol: '9999A',
      name: '合成',
      market: 'TWSE',
      kind: 'stock',
      item_id: c.bank.id,
    }),
  ).rejects.toMatchObject({ code: 'securities_require_twd_ledger' });
  await expect(
    securityService(f.db).price(f.actor, c.l.id, {
      market: 'TWSE',
      symbol: '9999A',
      price_date: '2026-01-01',
      price: '10',
    }),
  ).rejects.toMatchObject({ code: 'securities_require_twd_ledger' });
  await expect(
    securityService(f.db).apply(f.actor, c.l.id, randomUUID(), 'create', {}),
  ).rejects.toMatchObject({ code: 'securities_require_twd_ledger' });
});
it('holdings/manual priority/as-of/balance/MCP use the same read-only valuation', async () => {
  const c = await setup();
  await apply(c, trade(c, { fee: '10' }));
  await apply(
    c,
    trade(c, {
      trade_type: 'sell',
      quantity: '25',
      price: '20',
      fee: '1',
      tax: '2',
      trade_date: '2026-01-03',
    }),
  );
  await f.db`INSERT INTO market_prices(trade_date,market,symbol,close,source) VALUES('2026-01-03','TWSE','9999A',30,'twse') ON CONFLICT DO NOTHING`;
  await securityService(f.db).price(f.actor, c.l.id, {
    market: 'TWSE',
    symbol: '9999A',
    price_date: '2026-01-02',
    price: '20',
  });
  await securityService(f.db).price(f.actor, c.l.id, {
    market: 'TWSE',
    symbol: '9999A',
    price_date: '2026-02-01',
    price: '99',
  });
  const get = async (path: string, other = false) =>
    f.app.inject({
      method: 'GET',
      url: `/api/ledgers/${c.l.id}/${path}`,
      headers: other ? f.otherHeaders : f.headers,
    });
  const before =
    await f.db`SELECT (SELECT count(*) FROM transactions WHERE ledger_id=${c.l.id})::int t,(SELECT count(*) FROM transaction_entries WHERE ledger_id=${c.l.id})::int e,(SELECT count(*) FROM audit_logs)::int a`;
  const h = await get('reports/holdings?as_of=2026-01-04');
  expect(h.statusCode, h.body).toBe(200);
  expect(h.json().items[0]).toMatchObject({
    quantity: '75',
    cost: '757.50',
    average_cost: '10.1000',
    market_amount: '1500.00',
    unrealized_gain: '742.50',
    realized_gain: '244.50',
    price_source: 'manual',
    price_date: '2026-01-02',
  });
  const realized = await get(
    'reports/realized-gains?date_from=2026-01-01&date_to=2026-01-04',
  );
  expect(realized.statusCode, realized.body).toBe(200);
  expect(realized.json().total).toBe('244.50');
  const b = await get('reports/balance-sheet?as_of=2026-01-04');
  expect(b.statusCode, b.body).toBe(200);
  expect(
    b.json().items.find((i: { id: string }) => i.id === c.holding!.id)
      .valuation,
  ).toMatchObject({
    market_amount: '1500.00',
    unrealized_amount: '742.50',
    source: 'manual',
  });
  expect(
    await f.db`SELECT (SELECT count(*) FROM transactions WHERE ledger_id=${c.l.id})::int t,(SELECT count(*) FROM transaction_entries WHERE ledger_id=${c.l.id})::int e,(SELECT count(*) FROM audit_logs)::int a`,
  ).toEqual(before);
  const manual = await get('manual-prices');
  expect(manual.statusCode, manual.body).toBe(200);
  expect(manual.json()).toHaveLength(2);
  const old = await get('reports/holdings?as_of=2026-01-01');
  expect(old.json().items[0]).toMatchObject({
    quantity: '0',
    cost: '0.00',
    missing: true,
  });
  const first = await get(`securities/${c.s!.id}/trades?limit=1`);
  expect(first.json().items).toHaveLength(1);
  const next = await get(
    `securities/${c.s!.id}/trades?limit=1&cursor=${first.json().next_cursor}`,
  );
  expect(next.json().items).toHaveLength(1);
  expect(next.json().items[0].trade_date).toBe('2026-01-02');
  expect(next.json().next_cursor).toBeNull();
  for (const p of [
    'reports/holdings',
    'reports/realized-gains',
    `securities/${c.s!.id}/trades`,
    'manual-prices',
  ])
    expect((await get(p, true)).statusCode).toBe(404);
});
it('backup v4 full preserves snapshots and positions; structure omits trades/prices; references remain enforced', async () => {
  const {
    backupService,
    restoreService,
    backupPayloadSha256,
    securityReports,
  } = await import('@finmichi/core');
  const c = await setup();
  await apply(c, trade(c));
  await apply(c, {
    trade_type: 'stock_dividend',
    quantity: '10',
    trade_date: '2026-01-03',
  });
  await apply(
    c,
    trade(c, {
      trade_type: 'sell',
      quantity: '20',
      price: '15',
      trade_date: '2026-01-04',
    }),
  );
  await securityService(f.db).price(f.actor, c.l.id, {
    market: 'TWSE',
    symbol: '9999A',
    price_date: '2026-01-04',
    price: '14',
  });
  const original = await backupService(f.db).download(f.actor, c.l.id);
  expect(original.schemaVersion).toBe(9);
  expect(original.tables.security_trades).toHaveLength(3);
  const full = await restoreService(f.db).confirm(f.actor, original, {
    mode: 'full',
    name: 'Stock restore ' + randomUUID(),
  });
  const restored = await backupService(f.db).download(f.actor, full.ledger.id);
  for (let i = 0; i < original.tables.security_trades.length; i++) {
    const a = original.tables.security_trades[i]!,
      b = restored.tables.security_trades[i]!;
    for (const k of [
      'sequence',
      'trade_date',
      'position_cost',
      'position_quantity',
      'cost_removed',
      'realized_gain',
    ] as const)
      expect(b[k]).toBe(a[k]);
    expect(b.id).not.toBe(a.id);
    expect(b.security_id).toBe(full.id_map.securities[a.security_id]);
    if (a.transaction_id)
      expect(b.transaction_id).toBe(full.id_map.transactions[a.transaction_id]);
  }
  const h1 = await securityReports(f.db).holdings(f.actor, c.l.id, {
      as_of: '2026-01-05',
    }),
    h2 = await securityReports(f.db).holdings(f.actor, full.ledger.id, {
      as_of: '2026-01-05',
    });
  expect(h2.totals).toEqual(h1.totals);
  const structure = await restoreService(f.db).confirm(f.actor, original, {
    mode: 'structure',
    name: 'Stock structure ' + randomUUID(),
  });
  const sb = await backupService(f.db).download(f.actor, structure.ledger.id);
  expect(sb.tables.securities).toHaveLength(1);
  expect(sb.tables.security_trades).toHaveLength(0);
  expect(sb.tables.manual_prices).toHaveLength(0);
  expect(sb.tables.items.find((i) => i.securities)).toBeTruthy();
  const bad = structuredClone(original);
  bad.tables.security_trades[0]!.transaction_id = randomUUID();
  bad.payloadSha256 = backupPayloadSha256(bad.tables);
  await expect(
    restoreService(f.db).confirm(f.actor, bad, {
      name: 'Bad stock ' + randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'reference_invalid' });
});
it('update/delete replays; insufficient shares and stale previews roll back all data', async () => {
  const c = await setup();
  const buy = await apply(c, trade(c));
  const sell = await apply(
    c,
    trade(c, {
      trade_type: 'sell',
      quantity: '80',
      price: '20',
      trade_date: '2026-01-03',
    }),
  );
  const snapshot = () =>
    f.db`SELECT id,transaction_id,position_quantity::text,position_cost::text,cost_removed::text FROM security_trades WHERE ledger_id=${c.l.id} ORDER BY trade_date,sequence`;
  const before = await snapshot();
  const p = await preview(c, 'delete', undefined, buy.trade_id);
  expect(p.statusCode, p.body).toBe(409);
  expect(p.json().error).toBe('insufficient_shares');
  expect(await snapshot()).toEqual(before);
  const stale = await preview(
    c,
    'create',
    trade(c, { trade_date: '2026-01-04' }),
  );
  await apply(c, trade(c, { trade_date: '2026-01-04' }));
  const denied = await f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${c.l.id}/securities/${c.s!.id}/trades`,
    headers: f.headers,
    payload: {
      trade: trade(c, { trade_date: '2026-01-04' }),
      preview_hash: stale.json().preview_hash,
      confirm_recalculation: true,
    },
  });
  expect(denied.statusCode, denied.body).toBe(409);
  expect(denied.json().error).toBe('preview_changed');
  await apply(c, trade(c, { price: '30' }), 'update', buy.trade_id);
  const [r] =
    await f.db`SELECT cost_removed::text,realized_gain::text FROM security_trades WHERE id=${sell.trade_id}`;
  expect(r).toEqual({ cost_removed: '2400.00', realized_gain: '-800.00' });
  const d = await preview(c, 'delete', undefined, sell.trade_id);
  const deleted = await f.app.inject({
    method: 'DELETE',
    url: `/api/ledgers/${c.l.id}/securities/${c.s!.id}/trades/${sell.trade_id}`,
    headers: f.headers,
    payload: {
      preview_hash: d.json().preview_hash,
      confirm_recalculation: true,
    },
  });
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect(
    await f.db`SELECT id FROM security_trades WHERE id=${sell.trade_id}`,
  ).toHaveLength(0);
});
it('mid-recalculation DB failure leaves no partial trade, transaction, position or success audit', async () => {
  const c = await setup();
  await apply(c, trade(c));
  const sold = await apply(
    c,
    trade(c, {
      trade_type: 'sell',
      trade_date: '2026-01-03',
      price: '20',
      fee: '1',
    }),
  );
  const [target] =
    await f.db`SELECT transaction_id FROM security_trades WHERE id=${sold.trade_id}`;
  const snapshot = async () => ({
    trades:
      await f.db`SELECT * FROM security_trades WHERE ledger_id=${c.l.id} ORDER BY id`,
    entries:
      await f.db`SELECT * FROM transaction_entries WHERE ledger_id=${c.l.id} ORDER BY id`,
    transactions:
      await f.db`SELECT * FROM transactions WHERE ledger_id=${c.l.id} ORDER BY id`,
  });
  const before = await snapshot();
  const input = trade(c, { trade_date: '2026-01-01', price: '30' });
  const p = await preview(c, 'create', input);
  await f.db.unsafe(
    `CREATE FUNCTION test_stock_atomic_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.transaction_id='${target!.transaction_id}'::uuid THEN RAISE EXCEPTION 'synthetic mid-recalculation failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_stock_atomic_failure BEFORE INSERT ON transaction_entries FOR EACH ROW EXECUTE FUNCTION test_stock_atomic_failure()`,
  );
  try {
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/ledgers/${c.l.id}/securities/${c.s!.id}/trades`,
      headers: f.headers,
      payload: {
        trade: input,
        preview_hash: p.json().preview_hash,
        confirm_recalculation: true,
      },
    });
    expect(r.statusCode).toBe(500);
    expect(await snapshot()).toEqual(before);
  } finally {
    await f.db.unsafe(
      'DROP TRIGGER test_stock_atomic_failure ON transaction_entries; DROP FUNCTION test_stock_atomic_failure()',
    );
  }
});
it('same-day order, retroactive stock-dividend/adjust and fee precision are enforced', async () => {
  const c = await setup();
  const buy = await apply(c, trade(c));
  const sold = await apply(
    c,
    trade(c, { trade_type: 'sell', quantity: '50', price: '20' }),
  );
  const div = await apply(c, {
    trade_type: 'stock_dividend',
    trade_date: '2026-01-02',
    quantity: '100',
    sequence: 2,
  });
  const [r] =
    await f.db`SELECT cost_removed::text FROM security_trades WHERE id=${sold.trade_id}`;
  expect(r!.cost_removed).toBe('250.00');
  const p = await preview(
    c,
    'update',
    trade(c, { trade_type: 'sell', quantity: '50', sequence: 1 }),
    sold.trade_id,
  );
  expect(p.statusCode).toBe(409);
  expect(p.json().error).toBe('insufficient_shares');
  expect(p.json().details).toMatchObject({
    date: '2026-01-02',
    shortfall: '50',
  });
  for (const field of ['fee', 'tax'])
    expect(
      (await preview(c, 'create', trade(c, { [field]: '0.001' }))).statusCode,
    ).toBe(400);
  const adjust = await apply(c, {
    trade_type: 'adjust',
    trade_date: '2026-01-02',
    sequence: 3,
    quantity_after: '300',
    cost_mode: 'keep',
  });
  expect(adjust.position.quantity_after).toBe('300');
  expect(
    (
      await preview(c, 'create', {
        trade_type: 'adjust',
        trade_date: '2026-01-05',
        quantity_after: '0',
        cost_mode: 'keep',
      })
    ).json().error,
  ).toBe('adjust_cost_required');
  expect(buy.trade_id).not.toBe(div.trade_id);
});
it('official MCP client shares holdings/realized services, scope isolation and safe audit', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { patService } = await import('@finmichi/core');
  const c = await setup();
  await apply(c, trade(c, { note: 'PRIVATE_STOCK_NOTE' }));
  const pat = await patService(f.db).create(f.actor, {
    scope: 'read',
    expires_in_days: 1,
    ledger_ids: [c.l.id],
    mask_text: true,
  });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'stock-synthetic', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(address + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + pat.token } },
      }),
    );
    for (const report of ['holdings', 'realized-gains']) {
      const result = await client.callTool({
        name: 'get_report',
        arguments: { ledger_id: c.l.id, report },
      });
      expect(result.isError).not.toBe(true);
      const text = (result.content as { text: string }[])[0]!.text;
      expect(text).not.toContain('PRIVATE_STOCK_NOTE');
      expect(JSON.parse(text).report).toBe(report);
    }
    const denied = await client.callTool({
      name: 'get_report',
      arguments: { ledger_id: randomUUID(), report: 'holdings' },
    });
    expect(denied.isError).toBe(true);
    const audit =
      await f.db`SELECT action,outcome,tool,token_prefix FROM audit_logs WHERE user_id=${f.actor} AND action='mcp.call'`;
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audit).includes(pat.token)).toBe(false);
    expect(audit.every((r) => r.token_prefix === pat.token.slice(0, 8))).toBe(
      true,
    );
    expect(JSON.stringify(audit)).not.toMatch(/PRIVATE_STOCK_NOTE|1000\.00/);
  } finally {
    await client.close();
  }
});
it('concurrent writes sharing a preview commit exactly once; archived new use and empty entries are rejected', async () => {
  const c = await setup(),
    data = trade(c);
  const p = await preview(c, 'create', data);
  const path = `/api/ledgers/${c.l.id}/securities/${c.s!.id}/trades`;
  const response = await Promise.all(
    [1, 2].map(() =>
      f.app.inject({
        method: 'POST',
        url: path,
        headers: f.headers,
        payload: {
          trade: data,
          preview_hash: p.json().preview_hash,
          confirm_recalculation: true,
        },
      }),
    ),
  );
  expect(response.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(
    await f.db`SELECT id FROM security_trades WHERE security_id=${c.s!.id}`,
  ).toHaveLength(1);
  await itemService(f.db).update(f.actor, c.l.id, c.holding!.id, {
    archived: true,
  });
  const blocked = await preview(
    c,
    'create',
    trade(c, { trade_date: '2026-01-03' }),
  );
  expect(blocked.statusCode).toBe(400);
  expect(blocked.json().error).toBe('archived_resource');
  await itemService(f.db).update(f.actor, c.l.id, c.holding!.id, {
    archived: false,
  });
  const zero = await preview(
    c,
    'create',
    trade(c, {
      quantity: '1',
      price: '0',
      fee: '0',
      tax: '0',
      trade_date: '2026-01-03',
    }),
  );
  expect(zero.statusCode).toBe(400);
  expect(zero.json().error).toBe('invalid_input');
});
it('flagged legacy book balance without a position remains book-valued and explicitly missing', async () => {
  const { transactionService, reportService } = await import('@finmichi/core');
  const c = await setup();
  const other = await itemService(f.db).create(f.actor, c.l.id, {
    name: 'Synthetic legacy holding',
    kind: 'asset',
    currency: 'TWD',
  });
  await transactionService(f.db).create(f.actor, c.l.id, {
    occurred_on: '2026-01-01',
    entries: [
      { item_id: other.id, amount: '100' },
      { item_id: c.bank.id, amount: '-100' },
    ],
  });
  await itemService(f.db).update(f.actor, c.l.id, other.id, {
    securities: true,
  });
  const r = await reportService(f.db).balance(f.actor, c.l.id, {
    as_of: '2026-01-02',
  });
  expect(r.items.find((i) => i.id === other.id)!.valuation).toMatchObject({
    market_amount: '100.00',
    missing: true,
    source: 'missing',
  });
});
