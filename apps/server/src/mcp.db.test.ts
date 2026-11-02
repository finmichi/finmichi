// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  patService,
  forecastToday,
  addDays,
  budgetService,
  itemService,
  namedRecordService,
  transactionService,
  ledgerService,
  mcpTools,
  consumeMcpRequest,
} from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
describe('official MCP SDK read-only integration', () => {
  let f: Awaited<ReturnType<typeof fixture>>, url: URL;
  let pat: Awaited<ReturnType<ReturnType<typeof patService>['create']>>;
  let source: string, dest: string;
  const markers = [
    'MCP_MEMO_PRIVATE',
    'MCP_INVOICE_PRIVATE',
    'MCP_PAYEE_PRIVATE',
    'MCP_PROJECT_PRIVATE',
  ];
  const clients: Client[] = [];
  const prefixes = new Map<Client, string>();
  async function client(token: string) {
    const c = new Client({ name: 'synthetic-official-client', version: '1' });
    const t = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    });
    await c.connect(t as unknown as Transport);
    clients.push(c);
    prefixes.set(c, token.slice(0, 8));
    return c;
  }
  async function call(
    c: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const before =
      await f.db`SELECT count(*)::int AS n FROM audit_logs WHERE user_id=${f.actor} AND action='mcp.call'`;
    const result = await c.callTool({ name, arguments: args });
    const after =
      await f.db`SELECT tool,token_prefix FROM audit_logs WHERE user_id=${f.actor} AND action='mcp.call' ORDER BY id`;
    expect(after.length).toBe(before[0]!.n + 1);
    expect(after.at(-1)!.tool).toBe(
      mcpTools.includes(name as (typeof mcpTools)[number]) ? name : null,
    );
    expect(after.at(-1)!.token_prefix).toBe(prefixes.get(c));
    const content = result.content as { type: string; text: string }[];
    return { result, value: JSON.parse(content[0]!.text) };
  }
  function raw(
    token?: string,
    extra: Record<string, string> = {},
    body: unknown = { jsonrpc: '2.0', id: 1, method: 'ping' },
  ) {
    return fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    });
  }
  beforeAll(async () => {
    f = await fixture('mcp-sdk');
    source = (
      await itemService(f.db).create(f.actor, f.ledger, {
        name: '合成現金',
        kind: 'asset',
        currency: 'TWD',
      })
    ).id;
    dest = (
      await itemService(f.db).create(f.actor, f.ledger, {
        name: '合成支出',
        kind: 'expense',
        currency: 'TWD',
      })
    ).id;
    await budgetService(f.db).save(f.actor, f.ledger, {
      year: 2026,
      item_id: dest,
      months: [{ month: 1, amount: '75.00' }],
    });
    const payee = await namedRecordService(f.db, 'payees').create(
      f.actor,
      f.ledger,
      { name: markers[2] },
    );
    const project = await namedRecordService(f.db, 'projects').create(
      f.actor,
      f.ledger,
      { name: markers[3] },
    );
    for (let i = 0; i < 3; i++)
      await transactionService(f.db).create(f.actor, f.ledger, {
        occurred_on: '2026-01-02',
        memo: markers[0],
        invoice_no: markers[1],
        payee_id: payee.id,
        project_id: project.id,
        entries: [
          { item_id: source, amount: '-100' },
          { item_id: dest, amount: '100' },
        ],
      });
    pat = await patService(f.db).create(f.actor, {
      expires_in_days: 1,
      ledger_ids: [f.ledger],
      mask_text: false,
    });
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    url = new URL('/mcp', address);
  });
  afterAll(async () => {
    for (const c of clients) await c.close();
    await f.close();
  });
  it('official client discovers only five read tools and both resource types; REST-equivalent tools and money strings', async () => {
    const c = await client(pat.token);
    expect(c.getServerVersion()?.name).toBe('finmichi');
    expect(
      (await c.listTools()).tools.every((tool) =>
        tool.description?.includes('FinMichi'),
      ),
    ).toBe(true);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(
      [...mcpTools].sort(),
    );
    expect((await c.listResources()).resources.map((r) => r.uri)).toContain(
      'finmichi://docs/report-fields',
    );
    expect(
      (await c.listResourceTemplates()).resourceTemplates[0]!.uriTemplate,
    ).toBe('finmichi://ledgers/{id}/items');
    expect(
      (await c.readResource({ uri: 'finmichi://docs/report-fields' }))
        .contents[0],
    ).toHaveProperty('text');
    const resource = await c.readResource({
      uri: `finmichi://ledgers/${f.ledger}/items`,
    });
    const rest = async (path: string) =>
      (await f.app.inject({ url: path, headers: f.headers })).json();
    expect((await call(c, 'list_ledgers')).value).toEqual(
      await rest('/api/ledgers'),
    );
    const items = await rest(
      `/api/ledgers/${f.ledger}/items?include_archived=true`,
    );
    expect(
      (
        await call(c, 'list_items', {
          ledger_id: f.ledger,
          include_archived: true,
        })
      ).value,
    ).toEqual(items);
    expect(JSON.parse(String(resource.contents[0]!.text))).toEqual(items);
    const q = await call(c, 'search_transactions', {
      ledger_id: f.ledger,
      limit: 2,
    });
    expect(q.value).toEqual(
      await rest(`/api/ledgers/${f.ledger}/transactions?limit=2`),
    );
    expect(typeof q.value.items[0].transaction_amount).toBe('string');
    const more = await call(c, 'search_transactions', {
      ledger_id: f.ledger,
      limit: 2,
      cursor: q.value.next_cursor,
    });
    expect(more.value.items).toHaveLength(1);
    const balance = await rest(
      `/api/ledgers/${f.ledger}/reports/balance-sheet?as_of=2026-12-31`,
    );
    expect(
      (
        await call(c, 'get_balance', {
          ledger_id: f.ledger,
          as_of: '2026-12-31',
          item_id: source,
        })
      ).value,
    ).toEqual({
      totals: balance.totals,
      item: balance.items.find((x: { id: string }) => x.id === source),
    });
    for (const [report, args] of [
      [
        'profit-loss',
        { date_from: '2026-01-01', date_to: '2026-01-31', grain: 'month' },
      ],
      [
        'net-worth-flow',
        { date_from: '2026-01-01', date_to: '2026-01-31', grain: 'month' },
      ],
      [
        'account-ledger',
        { date_from: '2026-01-01', date_to: '2026-01-31', item_id: source },
      ],
      ['cash-forecast', { horizon_days: '30', threshold: '0' }],
      ['budget-vs-actual', { year: '2026', grain: 'month', kind: 'expense' }],
      ['balance-sheet', { as_of: '2026-12-31' }],
      [
        'income-summary',
        { date_from: '2026-01-01', date_to: '2026-01-31', grain: 'day' },
      ],
      [
        'category-statistics',
        { date_from: '2026-01-01', date_to: '2026-01-31', kind: 'expense' },
      ],
    ] as const) {
      const actual = (
        await call(c, 'get_report', { ledger_id: f.ledger, report, ...args })
      ).value;
      const expected = await rest(
        `/api/ledgers/${f.ledger}/reports/${report}?` +
          new URLSearchParams(args),
      );
      delete actual.generated_at;
      delete expected.generated_at;
      expect(actual).toEqual(expected);
    }
  });
  it('P&L fixed parameter is rejected by the shared strict MCP contract', async () => {
    const c = await client(pat.token);
    const r = await call(c, 'get_report', {
      ledger_id: f.ledger,
      report: 'profit-loss',
      date_from: '2026-01-01',
      date_to: '2026-01-31',
      grain: 'month',
      fixed: 'all',
    });
    expect(r.result.isError).toBe(true);
    expect(r.value.error).toBe('invalid_input');
  });
  it('mask on removes all text markers and off preserves them; every tool call has exactly one safe audit', async () => {
    const svc = patService(f.db),
      masked = await svc.create(f.actor, { expires_in_days: 1 });
    const c = await client(masked.token);
    const before =
      await f.db`SELECT id FROM audit_logs WHERE user_id=${f.actor} AND action='mcp.call'`;
    const { result, value } = await call(c, 'search_transactions', {
      ledger_id: f.ledger,
      keyword: markers[0],
    });
    for (const marker of markers)
      expect(JSON.stringify(result)).not.toContain(marker);
    expect(value.items[0].memo).toBe('[masked]');
    const ledgerReport = await call(c, 'get_report', {
      ledger_id: f.ledger,
      report: 'account-ledger',
      item_id: source,
      date_from: '2026-01-01',
      date_to: '2026-01-31',
    });
    expect(ledgerReport.value.items[0].memo).toBe('[masked]');
    expect(JSON.stringify(ledgerReport.result)).not.toContain(markers[0]);
    expect(value.items[0].entries[0].item_name).toBe('合成現金');
    expect(value.items[0].entries[0].amount).toBe('-100.000000');
    const unmasked = await call(
      await client(pat.token),
      'search_transactions',
      { ledger_id: f.ledger },
    );
    for (const marker of markers)
      expect(JSON.stringify(unmasked.result)).toContain(marker);
    const rows =
      await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} AND action='mcp.call' ORDER BY id`;
    expect(rows.length - before.length).toBe(3);
    expect(rows.at(-3)!.tool).toBe('search_transactions');
    expect(rows.at(-2)!.tool).toBe('get_report');
    expect(rows.at(-2)!.token_prefix).toBe(masked.token_prefix);
    const text = JSON.stringify(rows);
    for (const marker of [...markers, masked.token, pat.token])
      expect(text).not.toContain(marker);
    expect(text).not.toMatch(
      /"(?:arguments|params|output|memo|amount|invoice_no|token_hash)"/,
    );
  });
  it('cash forecast uses the same service and masks future transaction text; every invocation audits only metadata', async () => {
    await transactionService(f.db).create(f.actor, f.ledger, {
      occurred_on: addDays(forecastToday(), 1),
      memo: markers[0],
      entries: [
        { item_id: source, amount: '-1' },
        { item_id: dest, amount: '1' },
      ],
    });
    const masked = await patService(f.db).create(f.actor, {
      expires_in_days: 1,
    });
    const c = await client(masked.token);
    const response = await call(c, 'get_report', {
      ledger_id: f.ledger,
      report: 'cash-forecast',
      accounts: [source],
      horizon_days: 30,
    });
    expect(response.result.isError).not.toBe(true);
    expect(response.value.events).toContainEqual(
      expect.objectContaining({ memo: '[masked]', source_type: 'transaction' }),
    );
    expect(JSON.stringify(response.value)).not.toContain(markers[0]);
    const unrelated = await ledgerService(f.db).create(f.actor, {
      name: '合成預估範圍外帳本',
    });
    const denied = await patService(f.db).create(f.actor, {
      expires_in_days: 1,
      ledger_ids: [unrelated.id],
    });
    const other = await client(denied.token);
    expect(
      (
        await call(other, 'get_report', {
          ledger_id: f.ledger,
          report: 'cash-forecast',
        })
      ).value.error,
    ).toBe('not_found');
  });
  it('all tools deny forbidden ledgers; invalid input and period cap produce safe tool errors', async () => {
    const c = await client(pat.token),
      other = await ledgerService(f.db).create(f.actor, {
        name: 'outside PAT scope',
      });
    expect(
      (await call(c, 'list_ledgers')).value.map((l: { id: string }) => l.id),
    ).not.toContain(other.id);
    const stranger = (
      await f.app.inject({
        method: 'POST',
        url: '/api/ledgers',
        headers: f.otherHeaders,
        payload: { name: 'MCP foreign ledger' },
      })
    ).json().id;
    for (const ledger_id of [other.id, stranger])
      for (const [name, args] of [
        ['list_items', {}],
        ['search_transactions', {}],
        ['get_balance', { as_of: '2026-01-01' }],
        ['get_report', { report: 'balance-sheet', as_of: '2026-01-01' }],
      ] as const) {
        const got = await call(c, name, { ledger_id, ...args });
        expect(got.result.isError).toBe(true);
        expect(got.value.error).toBe('not_found');
      }
    await expect(
      c.readResource({ uri: `finmichi://ledgers/${stranger}/items` }),
    ).rejects.toThrow('not_found');
    expect(
      (
        await call(c, 'search_transactions', {
          ledger_id: f.ledger,
          limit: 101,
        })
      ).value.error,
    ).toBe('invalid_input');
    expect(
      (
        await call(c, 'get_report', {
          ledger_id: f.ledger,
          report: 'income-summary',
          date_from: '2020-01-01',
          date_to: '2026-01-01',
          grain: 'day',
        })
      ).value.error,
    ).toBe('period_range_too_large');
    expect((await call(c, 'delete_transaction', {})).result.isError).toBe(true);
  });
  it('Bearer only; expiry/revoke, exact Origin, no Origin allowed and 1 MiB request cap', async () => {
    expect((await raw()).status).toBe(401);
    expect((await raw(undefined, { cookie: f.headers.cookie })).status).toBe(
      401,
    );
    expect((await raw('llp_' + 'x'.repeat(43))).status).toBe(401);
    expect(
      (await raw(pat.token, { origin: 'https://evil.invalid' })).status,
    ).toBe(403);
    expect((await raw(pat.token, { origin: f.headers.origin })).status).toBe(
      200,
    );
    const noOrigin = await raw(pat.token);
    expect(noOrigin.status).toBe(200);
    expect(noOrigin.headers.get('cache-control')).toBe('no-store');
    expect(noOrigin.headers.get('mcp-session-id')).toBeNull();
    for (const method of ['GET', 'DELETE'])
      expect(
        (
          await fetch(url, {
            method,
            headers: { authorization: 'Bearer ' + pat.token },
          })
        ).status,
      ).toBe(405);
    const svc = patService(f.db),
      p = await svc.create(f.actor, { expires_in_days: 1 });
    await svc.revoke(f.actor, p.id);
    expect((await raw(p.token)).status).toBe(401);
    const exp = await svc.create(f.actor, { expires_in_days: 1 });
    await f.db`UPDATE personal_access_tokens SET created_at=now()-interval '3 days',expires_at=now()-interval '2 days' WHERE id=${exp.id}`;
    expect((await raw(exp.token)).status).toBe(401);
    expect(
      (
        await raw(
          pat.token,
          {},
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'ping',
            padding: 'x'.repeat(1024 * 1024),
          },
        )
      ).status,
    ).toBe(413);
  });
  it('request 61 returns 429; windows reset; concurrent requests share the same DB limit', async () => {
    const p = await patService(f.db).create(f.actor, { expires_in_days: 1 });
    for (let i = 1; i <= 60; i++)
      expect((await raw(p.token)).status, 'request ' + i).toBe(200);
    const blocked = await raw(p.token);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    await f.db`UPDATE personal_access_tokens SET request_window_at=now()-interval '61 seconds' WHERE id=${p.id}`;
    const results = await Promise.all(
      Array.from({ length: 65 }, () => consumeMcpRequest(f.db, p.id)),
    );
    expect(results.filter(Boolean)).toHaveLength(60);
  });
  it('large tool output is refused as a safe error and a smaller page succeeds', async () => {
    const ledger = await ledgerService(f.db).create(f.actor, {
      name: 'MCP synthetic size boundary',
    });
    const a = await itemService(f.db).create(f.actor, ledger.id, {
      name: '甲'.repeat(190),
      kind: 'asset',
      currency: 'TWD',
    });
    const b = await itemService(f.db).create(f.actor, ledger.id, {
      name: '乙'.repeat(190),
      kind: 'expense',
      currency: 'TWD',
    });
    const entries = Array.from({ length: 100 }, (_, i) => ({
      item_id: i % 2 ? a.id : b.id,
      amount: i % 2 ? '-1' : '1',
    }));
    for (let i = 0; i < 25; i++)
      await transactionService(f.db).create(f.actor, ledger.id, {
        occurred_on: '2026-01-01',
        entries,
      });
    const p = await patService(f.db).create(f.actor, {
      expires_in_days: 1,
      ledger_ids: [ledger.id],
    });
    const c = await client(p.token);
    const big = await call(c, 'search_transactions', {
      ledger_id: ledger.id,
      limit: 100,
    });
    expect(big.result.isError).toBe(true);
    expect(big.value.error).toBe('output_too_large');
    expect(big.value.message).toContain('分頁');
    const small = await call(c, 'search_transactions', {
      ledger_id: ledger.id,
      limit: 1,
    });
    expect(small.value.items).toHaveLength(1);
    expect(small.value.next_cursor).toBeTruthy();
  }, 30000);
});
