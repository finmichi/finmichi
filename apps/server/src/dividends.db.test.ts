// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from '../test/catalog-fixture.js';
import {
  itemService,
  ledgerService,
  securityService,
  dividendService,
  backupService,
  restoreService,
  backupPayloadSha256,
} from '@finmichi/core';
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture('dividends-' + randomUUID());
});
afterAll(async () => {
  if (f) await f.close();
});
async function setup() {
  const l = await ledgerService(f.db).create(f.actor, {
    name: 'Synthetic dividends ' + randomUUID(),
  });
  const items = itemService(f.db);
  const bank = await items.create(f.actor, l.id, {
      name: 'Synthetic bank',
      kind: 'asset',
      currency: 'TWD',
    }),
    holding = await items.create(f.actor, l.id, {
      name: 'Synthetic stock',
      kind: 'asset',
      currency: 'TWD',
      securities: true,
    });
  const s = await securityService(f.db).create(f.actor, l.id, {
    symbol: '9999D',
    name: '合成股利股票',
    market: 'TWSE',
    kind: 'stock',
    item_id: holding.id,
  });
  const ds = dividendService(f.db),
    defs = await ds.initialize(f.actor, l.id);
  return { l, bank, holding, s, ds, defs };
}
type C = Awaited<ReturnType<typeof setup>>;
function input(c: C, patch = {}) {
  return {
    security_id: c.s.id,
    ex_date: '2026-10-01',
    pay_date: '2026-10-15',
    shares: '100',
    per_share: '10',
    gross_amount: '1000',
    net_amount: '875',
    withholding_tax: '100',
    nhi_premium: '20',
    fee: '5',
    stock_shares: '0',
    settlement_item_id: c.bank.id,
    ...c.defs,
    disclaimer: undefined,
    components: [
      { code: '54C', label: '合成組成', amount: '700', taxable: true },
      { code: 'free', label: '自訂組成', amount: '300', taxable: false },
    ],
    ...patch,
  };
}
function payload(c: C, patch = {}) {
  const { disclaimer: _, ...d } = input(c, patch);
  void _;
  return d;
}
async function request(
  c: C,
  operation: 'create' | 'update' | 'delete',
  d?: unknown,
  id?: string,
  confirm = true,
) {
  const p = await f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${c.l.id}/dividend-preview`,
    headers: f.headers,
    payload: {
      operation,
      ...(id ? { id } : {}),
      ...(d ? { dividend: d } : {}),
    },
  });
  expect(p.statusCode, p.body).toBe(200);
  const r = await f.app.inject({
    method:
      operation === 'create'
        ? 'POST'
        : operation === 'update'
          ? 'PUT'
          : 'DELETE',
    url: `/api/ledgers/${c.l.id}/dividends${id ? '/' + id : ''}`,
    headers: f.headers,
    payload: {
      ...(d ? { dividend: d } : {}),
      preview_hash: p.json().preview_hash,
      confirm_recalculation: confirm,
    },
  });
  return { r, p };
}
async function stock(c: C, type = 'buy', day = '2026-09-01', quantity = '100') {
  const s = securityService(f.db),
    t = {
      trade_type: type,
      trade_date: day,
      quantity,
      price: type === 'buy' ? '10' : '20',
      fee: '0',
      tax: '0',
      settlement_item_id: c.bank.id,
      gain_item_id: c.defs.default_income_item_id,
      expense_item_id: c.defs.expense_item_id,
    };
  const p = await s.preview(f.actor, c.l.id, c.s.id, {
    operation: 'create',
    trade: t,
  });
  return s.apply(f.actor, c.l.id, c.s.id, 'create', {
    trade: t,
    preview_hash: p.preview_hash,
    confirm_recalculation: true,
  });
}
it('HTTP cash dividend independent postings, mappings, metadata only, zero sum and period/code report', async () => {
  const c = await setup(),
    d = payload(c, {
      note: 'Synthetic secret note',
      source_document: {
        filename: 'synthetic.pdf',
        sha256: 'a'.repeat(64),
        page: 2,
      },
    });
  const { r } = await request(c, 'create', d);
  expect(r.statusCode, r.body).toBe(200);
  const saved = r.json();
  const entries =
    await f.db`SELECT i.name,round(e.amount,2)::text amount FROM transaction_entries e JOIN items i ON i.id=e.item_id WHERE transaction_id=${saved.transaction_id} ORDER BY e.entry_position`;
  expect(entries.map((e) => e.amount)).toEqual([
    '875.00',
    '-1000.00',
    '120.00',
    '5.00',
  ]);
  const [t] =
    await f.db`SELECT occurred_on::text FROM transactions WHERE id=${saved.transaction_id}`;
  expect(t!.occurred_on).toBe('2026-10-15');
  const report = await c.ds.report(f.actor, c.l.id, {
    date_from: '2026-10-01',
    date_to: '2026-10-31',
  });
  expect(report.totals).toEqual({
    count: 1,
    gross_amount: '1000.00',
    withholding_tax: '100.00',
    nhi_premium: '20.00',
    fee: '5.00',
    net_amount: '875.00',
  });
  expect(report.codes.map((x) => x.amount).sort()).toEqual([
    '300.00',
    '700.00',
  ]);
  expect(
    (await c.ds.report(f.actor, c.l.id, { date_from: '2026-11-01' })).items,
  ).toHaveLength(0);
});
it('shares use strict before ex date; pay-date stock does not affect an earlier sale; managed trade is protected', async () => {
  const c = await setup();
  await stock(c);
  await stock(c, 'buy', '2026-10-01', '20');
  expect(await c.ds.shares(f.actor, c.l.id, c.s.id, '2026-10-01')).toEqual({
    shares: '100',
    ex_date: '2026-10-01',
  });
  const sale = await stock(c, 'sell', '2026-10-10', '50');
  const { r } = await request(c, 'create', payload(c, { stock_shares: '10' }));
  expect(r.statusCode, r.body).toBe(200);
  const saved = r.json();
  const [t] =
    await f.db`SELECT trade_date::text,quantity::text FROM security_trades WHERE id=${saved.stock_trade_id}`;
  expect(t).toEqual({ trade_date: '2026-10-15', quantity: '10' });
  const [s] =
    await f.db`SELECT cost_removed::text FROM security_trades WHERE id=${sale.trade_id}`;
  expect(s!.cost_removed).toBe('500.00');
  await expect(
    securityService(f.db).preview(f.actor, c.l.id, c.s.id, {
      operation: 'delete',
      trade_id: saved.stock_trade_id,
    }),
  ).rejects.toThrow('dividend_managed_trade');
});
it('stock-only is allowed without transaction/components; full withholding omits zero cash', async () => {
  const c = await setup();
  await stock(c);
  const { r } = await request(
    c,
    'create',
    payload(c, {
      gross_amount: '0',
      net_amount: '0',
      withholding_tax: '0',
      nhi_premium: '0',
      fee: '0',
      stock_shares: '10',
      components: [],
      settlement_item_id: null,
    }),
  );
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().transaction_id).toBeNull();
  expect(r.json().stock_trade_id).toBeTruthy();
  const w = await request(
    c,
    'create',
    payload(c, {
      net_amount: '0',
      withholding_tax: '975',
      settlement_item_id: null,
    }),
  );
  expect(w.r.statusCode, w.r.body).toBe(200);
  expect(
    await f.db`SELECT 1 FROM transaction_entries WHERE transaction_id=${w.r.json().transaction_id} AND amount=0`,
  ).toHaveLength(0);
});
it('invalid sums, missing date, empty and zero-gross components have the specified HTTP errors', async () => {
  const c = await setup();
  for (const [patch, code] of [
    [{ net_amount: '876' }, 'dividend_amount_mismatch'],
    [{ pay_date: undefined }, 'pay_date_required'],
    [
      {
        gross_amount: '0',
        net_amount: '0',
        withholding_tax: '0',
        nhi_premium: '0',
        fee: '0',
        components: [],
      },
      'dividend_empty',
    ],
    [
      {
        gross_amount: '0',
        net_amount: '0',
        withholding_tax: '0',
        nhi_premium: '0',
        fee: '0',
        stock_shares: '1',
        components: [{ code: 'x', label: 'x', amount: '0', taxable: false }],
      },
      'dividend_amount_mismatch',
    ],
  ] as const) {
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/ledgers/${c.l.id}/dividend-preview`,
      headers: f.headers,
      payload: { operation: 'create', dividend: payload(c, patch) },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toBe(code);
  }
  expect(await c.ds.list(f.actor, c.l.id)).toHaveLength(0);
});
it('update/delete replays later sales, requires confirmation and respects locked affected dates', async () => {
  const c = await setup();
  await stock(c);
  const { r } = await request(c, 'create', payload(c, { stock_shares: '100' }));
  const d = r.json();
  await stock(c, 'sell', '2026-10-20', '100');
  const result = await request(
    c,
    'update',
    payload(c, { stock_shares: '200' }),
    d.id,
    false,
  );
  expect(result.p.json().recalculations).toHaveLength(1);
  expect(result.r.statusCode).toBe(409);
  expect(result.r.json().error).toBe('recalculation_confirmation_required');
  const updated = await request(
    c,
    'update',
    payload(c, { stock_shares: '200' }),
    d.id,
  );
  expect(updated.r.statusCode, updated.r.body).toBe(200);
  await ledgerService(f.db).setLock(f.actor, c.l.id, {
    locked_until: '2026-10-20',
  });
  await expect(
    c.ds.preview(f.actor, c.l.id, { operation: 'delete', id: d.id }),
  ).rejects.toThrow('period_locked');
  await ledgerService(f.db).setLock(f.actor, c.l.id, {
    locked_until: null,
    confirm_unlock: true,
  });
  const gone = await request(c, 'delete', undefined, d.id);
  expect(gone.r.statusCode, gone.r.body).toBe(200);
  expect(await c.ds.list(f.actor, c.l.id)).toHaveLength(0);
  expect(
    await f.db`SELECT 1 FROM security_trades WHERE id=${d.stock_trade_id}`,
  ).toHaveLength(0);
});
it('generic transaction mutation cannot detach dividend accounting; scope isolation and TWD restriction', async () => {
  const c = await setup(),
    { r } = await request(c, 'create', payload(c));
  for (const method of ['PATCH', 'DELETE'] as const) {
    const out = await f.app.inject({
      method,
      url: `/api/ledgers/${c.l.id}/transactions/${r.json().transaction_id}`,
      headers: f.headers,
      ...(method === 'PATCH' ? { payload: { memo: 'other' } } : {}),
    });
    expect(out.statusCode, out.body).toBe(409);
    expect(out.json().error).toBe('dividend_managed_transaction');
  }
  const other = await f.app.inject({
    method: 'GET',
    url: `/api/ledgers/${c.l.id}/dividends/${r.json().id}`,
    headers: f.otherHeaders,
  });
  expect(other.statusCode).toBe(404);
  const usd = await ledgerService(f.db).create(f.actor, {
    name: 'Synthetic USD ' + randomUUID(),
    base_currency: 'USD',
  });
  await expect(
    c.ds.preview(f.actor, usd.id, {
      operation: 'create',
      dividend: payload(c),
    }),
  ).rejects.toThrow('securities_require_twd_ledger');
});
it('full/structure backup remaps codes, components, cash and stock links without recalculation', async () => {
  const c = await setup();
  await stock(c);
  const { r } = await request(c, 'create', payload(c, { stock_shares: '10' }));
  expect(r.statusCode, r.body).toBe(200);
  const b = await backupService(f.db).download(f.actor, c.l.id);
  expect(b.schemaVersion).toBe(9);
  expect(b.tables.dividends).toHaveLength(1);
  const restore = restoreService(f.db);
  const full = await restore.confirm(f.actor, b, {
    name: 'Synthetic full ' + randomUUID(),
  });
  const rows = await c.ds.list(f.actor, full.ledger.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).not.toBe(r.json().id);
  expect(rows[0]!.transaction_id).not.toBe(r.json().transaction_id);
  expect(rows[0]!.stock_trade_id).not.toBe(r.json().stock_trade_id);
  expect(rows[0]!.gross_amount).toBe('1000');
  const struct = await restore.confirm(f.actor, b, {
    mode: 'structure',
    name: 'Synthetic structure ' + randomUUID(),
  });
  expect(await c.ds.list(f.actor, struct.ledger.id)).toHaveLength(0);
  expect((await c.ds.codes(f.actor, struct.ledger.id)).items).toHaveLength(1);
  const tampered = structuredClone(b);
  tampered.tables.dividend_components[0]!.amount = '1';
  tampered.payloadSha256 = backupPayloadSha256(tampered.tables);
  await expect(
    restore.confirm(f.actor, tampered, {
      name: 'Synthetic tamper ' + randomUUID(),
    }),
  ).rejects.toThrow();
});
it('official MCP client equals REST, masks note and filename, audits only metadata and exposes no dividend write tool', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { patService } = await import('@finmichi/core');
  const c = await setup();
  await request(
    c,
    'create',
    payload(c, {
      note: 'DIVIDEND_PRIVATE_NOTE',
      source_document: {
        filename: 'DIVIDEND_PRIVATE_DOCUMENT.pdf',
        sha256: 'a'.repeat(64),
        page: 1,
      },
    }),
  );
  const pat = await patService(f.db).create(f.actor, {
    scope: 'read',
    expires_in_days: 1,
    ledger_ids: [c.l.id],
    mask_text: true,
  });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'dividend-synthetic', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(address + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + pat.token } },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.some((t) => /dividend/.test(t.name))).toBe(false);
    const result = await client.callTool({
      name: 'get_report',
      arguments: { ledger_id: c.l.id, report: 'dividends' },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).not.toContain('DIVIDEND_PRIVATE');
    const value = JSON.parse(text);
    expect(value.totals).toEqual((await c.ds.report(f.actor, c.l.id)).totals);
    expect(
      (
        await client.callTool({
          name: 'get_report',
          arguments: { ledger_id: f.ledger, report: 'dividends' },
        })
      ).isError,
    ).toBe(true);
    const audit =
      await f.db`SELECT row_to_json(a)::text body FROM audit_logs a WHERE user_id=${f.actor}`;
    for (const row of audit) {
      expect(row.body).not.toMatch(/DIVIDEND_PRIVATE|gross_amount|components/);
      expect(row.body).not.toContain(pat.token);
    }
  } finally {
    await client.close();
  }
});
it('failure after stock replay rolls cash, dividend and positions back atomically; stale previews do not duplicate writes', async () => {
  const c = await setup();
  await stock(c);
  await stock(c, 'sell', '2026-10-20', '50');
  const d = payload(c, { stock_shares: '100' }),
    plan = await c.ds.preview(f.actor, c.l.id, {
      operation: 'create',
      dividend: d,
    });
  const before =
    await f.db`SELECT id,cost_removed::text,position_quantity::text,position_cost::text FROM security_trades WHERE ledger_id=${c.l.id} ORDER BY trade_date,sequence`;
  await f.db.unsafe(
    `CREATE FUNCTION test_dividend_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic dividend failure';END $$;CREATE TRIGGER test_dividend_failure BEFORE INSERT ON dividend_components FOR EACH ROW EXECUTE FUNCTION test_dividend_failure()`,
  );
  try {
    await expect(
      c.ds.apply(f.actor, c.l.id, 'create', {
        dividend: d,
        preview_hash: plan.preview_hash,
        confirm_recalculation: true,
      }),
    ).rejects.toThrow();
    expect(
      await f.db`SELECT id,cost_removed::text,position_quantity::text,position_cost::text FROM security_trades WHERE ledger_id=${c.l.id} ORDER BY trade_date,sequence`,
    ).toEqual(before);
    expect(await c.ds.list(f.actor, c.l.id)).toHaveLength(0);
  } finally {
    await f.db.unsafe(
      'DROP TRIGGER test_dividend_failure ON dividend_components;DROP FUNCTION test_dividend_failure()',
    );
  }
  await c.ds.apply(f.actor, c.l.id, 'create', {
    dividend: d,
    preview_hash: plan.preview_hash,
    confirm_recalculation: true,
  });
  await expect(
    c.ds.apply(f.actor, c.l.id, 'create', {
      dividend: d,
      preview_hash: plan.preview_hash,
      confirm_recalculation: true,
    }),
  ).rejects.toThrow('preview_changed');
});
