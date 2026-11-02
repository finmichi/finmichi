// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { fixture } from '../test/catalog-fixture.js';
import {
  patService,
  draftService,
  expireTransactionDrafts,
  runRecurringWorker,
  ledgerService,
  itemService,
  namedRecordService,
  transactionService,
  backupService,
  restoreService,
  mcpTools,
  mcpDraftTools,
  draftLimitSchema,
} from '@finmichi/core';
let f: Awaited<ReturnType<typeof fixture>>,
  url: URL,
  ledger: string,
  cash: string,
  expense: string;
let read: Awaited<ReturnType<ReturnType<typeof patService>['create']>>,
  write: typeof read,
  unmasked: typeof read;
const clients: Client[] = [];
async function client(token = write.token) {
  const c = new Client({ name: 'synthetic-draft-sdk', version: '1' });
  await c.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: 'Bearer ' + token } },
    }) as unknown as Transport,
  );
  clients.push(c);
  return c;
}
async function call(
  c: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const r = await c.callTool({ name, arguments: args });
  return {
    error: r.isError === true,
    value: JSON.parse((r.content as { text: string }[])[0]!.text),
  };
}
const data = (amount = '100') => ({
  occurred_on: '2026-10-21',
  memo: 'DRAFT_PRIVATE_MEMO',
  invoice_no: 'DRAFT_PRIVATE_INVOICE',
  entries: [
    { item_id: cash, amount: '-' + amount },
    { item_id: expense, amount },
  ],
});
async function principal(p = write) {
  return (await patService(f.db).authenticate(p.token))!;
}
async function create(amount = '100', p = write) {
  return draftService(f.db).create(
    await principal(p),
    ledger,
    data(amount),
    'DRAFT_PRIVATE_NOTE',
  );
}
const post = (
  id: string,
  action = 'approve',
  payload: unknown = {},
  headers = f.headers,
) =>
  f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${ledger}/drafts/${id}/${action}`,
    headers,
    payload,
  });
async function counts() {
  const [r] =
    await f.db`SELECT (SELECT count(*)::int FROM transactions WHERE ledger_id=${ledger}) tx,(SELECT count(*)::int FROM transaction_drafts WHERE ledger_id=${ledger}) drafts`;
  return r!;
}
beforeAll(async () => {
  f = await fixture('mcp-drafts');
  url = new URL('/mcp', await f.app.listen({ host: '127.0.0.1', port: 0 }));
  const s = patService(f.db);
  read = await s.create(f.actor, { expires_in_days: 1 });
  write = await s.create(f.actor, { scope: 'draft', expires_in_days: 1 });
  unmasked = await s.create(f.actor, {
    scope: 'draft',
    expires_in_days: 1,
    mask_text: false,
  });
});
afterAll(async () => {
  for (const c of clients) await c.close();
  if (f) await f.close();
});
beforeEach(async () => {
  ledger = (
    await ledgerService(f.db).create(f.actor, {
      name: '合成草稿 ' + randomUUID(),
    })
  ).id;
  cash = (
    await itemService(f.db).create(f.actor, ledger, {
      name: '合成現金',
      kind: 'asset',
      currency: 'TWD',
    })
  ).id;
  expense = (
    await itemService(f.db).create(f.actor, ledger, {
      name: '合成支出',
      kind: 'expense',
      currency: 'TWD',
    })
  ).id;
  await f.db`UPDATE personal_access_tokens SET request_count=0,request_window_at=NULL WHERE user_id=${f.actor}`;
});
it('official SDK read scope cannot use draft tools; draft inherits reads and exposes no approval/post/delete', async () => {
  const r = await client(read.token),
    d = await client();
  expect((await r.listTools()).tools.map((x) => x.name)).toEqual([...mcpTools]);
  const tools = (await d.listTools()).tools;
  expect(tools.map((x) => x.name)).toEqual([...mcpTools, ...mcpDraftTools]);
  expect(
    tools.find((x) => x.name === 'draft_transaction')!.annotations!
      .readOnlyHint,
  ).toBe(false);
  expect(tools.map((x) => x.name).join(' ')).not.toMatch(
    /approve|delete|post_transaction/,
  );
  for (const name of mcpDraftTools)
    expect(
      (await call(r, name, { ledger_id: ledger, ...data() })).value.error,
    ).toBe('insufficient_scope');
  expect(
    (await call(d, 'list_ledgers')).value.map((x: { id: string }) => x.id),
  ).toContain(ledger);
  expect(await counts()).toMatchObject({ tx: 0, drafts: 0 });
  expect((await call(d, 'approve_draft')).error).toBe(true);
});
it('preview failures never create a draft or transaction: balance/archive/lock/references/unknown fields', async () => {
  const c = await client();
  for (const entries of [
    [
      { item_id: cash, amount: '-1' },
      { item_id: expense, amount: '2' },
    ],
    [
      { item_id: randomUUID(), amount: '-1' },
      { item_id: expense, amount: '1' },
    ],
  ])
    expect(
      (
        await call(c, 'draft_transaction', {
          ledger_id: ledger,
          ...data(),
          entries,
        })
      ).error,
    ).toBe(true);
  expect(
    (
      await call(c, 'draft_transaction', {
        ledger_id: ledger,
        ...data(),
        source_system: 'forged',
      })
    ).value.error,
  ).toBe('invalid_input');
  await itemService(f.db).update(f.actor, ledger, expense, { archived: true });
  expect(
    (await call(c, 'draft_transaction', { ledger_id: ledger, ...data() })).value
      .error,
  ).toBe('archived_resource');
  await itemService(f.db).update(f.actor, ledger, expense, { archived: false });
  await ledgerService(f.db).setLock(f.actor, ledger, {
    locked_until: '2026-10-21',
  });
  expect(
    (await call(c, 'draft_transaction', { ledger_id: ledger, ...data() })).value
      .error,
  ).toBe('period_locked');
  expect(await counts()).toMatchObject({ tx: 0, drafts: 0 });
});
it('default amount boundary and configured hard maximum are exact base-currency positive-entry totals', async () => {
  const c = await client();
  expect(
    (
      await call(c, 'draft_transaction', {
        ledger_id: ledger,
        ...data('100000'),
      })
    ).error,
  ).toBe(false);
  expect(
    (
      await call(c, 'draft_transaction', {
        ledger_id: ledger,
        ...data('100000.01'),
      })
    ).value.error,
  ).toBe('draft_amount_limit');
  const s = draftService(f.db, '10000000');
  await s.create(await principal(), ledger, data('10000000'));
  await expect(
    s.create(await principal(), ledger, data('10000000.01')),
  ).rejects.toMatchObject({ code: 'draft_amount_limit' });
  for (const limit of ['0', '-1', '10000000.01', '1e5', '1.001', 'foo'])
    expect(draftLimitSchema.safeParse(limit).success).toBe(false);
  const usd = (
    await itemService(f.db).create(f.actor, ledger, {
      name: '美元',
      kind: 'asset',
      currency: 'USD',
    })
  ).id;
  expect(
    (
      await call(c, 'draft_transaction', {
        ledger_id: ledger,
        occurred_on: '2026-10-21',
        entries: [
          { item_id: usd, amount: '-100', exchange_rate: '2000' },
          { item_id: expense, amount: '200000' },
        ],
      })
    ).value.error,
  ).toBe('draft_amount_limit');
});
it('pending limit is per ledger across tokens; concurrent SDK calls serialize at 50 without posting', async () => {
  const a = await client(),
    b = await client(unmasked.token);
  for (let i = 0; i < 49; i++)
    expect(
      (await call(a, 'draft_transaction', { ledger_id: ledger, ...data() }))
        .error,
    ).toBe(false);
  const r = await Promise.all([
    call(a, 'draft_transaction', { ledger_id: ledger, ...data() }),
    call(b, 'draft_transaction', { ledger_id: ledger, ...data() }),
    call(b, 'draft_transaction', { ledger_id: ledger, ...data() }),
  ]);
  expect(r.filter((x) => !x.error)).toHaveLength(1);
  expect(r.filter((x) => x.value.error === 'draft_pending_limit')).toHaveLength(
    2,
  );
  expect(await counts()).toMatchObject({ tx: 0, drafts: 50 });
  const first = (await draftService(f.db).list(f.actor, ledger)).items[0]!;
  expect((await post(first.id, 'reject')).statusCode).toBe(204);
  expect(
    (await call(b, 'draft_transaction', { ledger_id: ledger, ...data() }))
      .error,
  ).toBe(false);
});
it.each(['A', 'C', 'BD'])(
  'cookie approval matches direct entry calculation scenario %s and source provenance',
  async (scenario) => {
    let payload: Record<string, unknown> = data();
    if (scenario === 'C') {
      const usd = (
        await itemService(f.db).create(f.actor, ledger, {
          name: '美元',
          kind: 'asset',
          currency: 'USD',
        })
      ).id;
      payload = {
        ...data(),
        entries: [
          { item_id: usd, amount: '-100', exchange_rate: '32.5' },
          { item_id: expense, amount: '4000' },
        ],
      };
    }
    if (scenario === 'BD') {
      const a = (
          await itemService(f.db).create(f.actor, ledger, {
            name: '外幣資產',
            kind: 'asset',
            currency: 'USD',
          })
        ).id,
        b = (
          await itemService(f.db).create(f.actor, ledger, {
            name: '外幣支出',
            kind: 'expense',
            currency: 'USD',
          })
        ).id;
      payload = {
        ...data(),
        entries: [
          { item_id: a, amount: '-0.010', exchange_rate: '1' },
          { item_id: b, amount: '0.005', exchange_rate: '1' },
          { item_id: b, amount: '0.005', exchange_rate: '1' },
        ],
      };
    }
    const c = await client(),
      r = await call(c, 'draft_transaction', { ledger_id: ledger, ...payload });
    expect(r.error).toBe(false);
    expect((await counts()).tx).toBe(0);
    const expected = await transactionService(f.db).create(
      f.actor,
      ledger,
      payload,
    );
    const approved = await post(r.value.id);
    expect(approved.statusCode).toBe(200);
    const actual = approved.json();
    const legs = (t: typeof actual) =>
      t.entries.map(({ id: _, ...e }: { id: string }) => {
        void _;
        return e;
      });
    expect(legs(actual)).toEqual(legs(expected));
    expect(actual.kind).toBe(expected.kind);
    const [source] =
      await f.db`SELECT source_system,source_id FROM transactions WHERE id=${actual.id}`;
    expect(source).toEqual({
      source_system: 'mcp-draft',
      source_id: r.value.id,
    });
    expect(
      (await draftService(f.db).get(f.actor, ledger, r.value.id)).status,
    ).toBe('approved');
  },
);
it('Bearer-only cannot approve; modified payload is revalidated and concurrent approvals create once', async () => {
  const d = await create();
  const bearer = {
    origin: f.headers.origin,
    authorization: 'Bearer ' + write.token,
  };
  expect(
    (await post(String(d.id), 'approve', {}, bearer as typeof f.headers))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await post(
        String(d.id),
        'approve',
        {},
        { ...f.headers, origin: 'https://foreign.invalid' },
      )
    ).statusCode,
  ).toBe(403);
  const edited = data('125.50');
  const rs = await Promise.all([
    post(String(d.id), 'approve', { payload: edited }),
    post(String(d.id), 'approve', { payload: edited }),
  ]);
  expect(rs.map((x) => x.statusCode).sort()).toEqual([200, 409]);
  expect((await counts()).tx).toBe(1);
  expect(
    (await draftService(f.db).get(f.actor, ledger, d.id)).payload.entries,
  ).toEqual(edited.entries);
});
it('approval fails atomically if locked, archived, invalid or above limit; rejection never posts', async () => {
  const d = await create();
  expect(
    (await post(String(d.id), 'approve', { payload: data('100000.01') })).json()
      .error,
  ).toBe('draft_amount_limit');
  await ledgerService(f.db).setLock(f.actor, ledger, {
    locked_until: '2026-10-21',
  });
  expect((await post(String(d.id))).json().error).toBe('period_locked');
  await ledgerService(f.db).setLock(f.actor, ledger, {
    locked_until: null,
    confirm_unlock: true,
  });
  await itemService(f.db).update(f.actor, ledger, expense, { archived: true });
  expect((await post(String(d.id))).json().error).toBe('archived_resource');
  expect((await post(String(d.id), 'reject')).statusCode).toBe(204);
  expect((await post(String(d.id))).statusCode).toBe(409);
  expect((await counts()).tx).toBe(0);
});
it('token-specific cursor pages are stable, masked recursively and owner/ledger scopes return 404', async () => {
  // Force distinct rows inside one millisecond: the cursor must preserve all six digits.
  for (let i = 0; i < 4; i++) {
    const draft = await create();
    await f.db`UPDATE transaction_drafts SET created_at='2026-10-23T00:00:00.123450Z'::timestamptz+${i}*interval '1 microsecond' WHERE id=${String(draft.id)}`;
  }
  await create('200', unmasked);
  const c = await client();
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const r = await call(c, 'list_drafts', {
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
    expect(JSON.stringify(r.value)).not.toMatch(/DRAFT_PRIVATE/);
    for (const x of r.value.items) {
      expect(x.payload.memo).toBe('[masked]');
      expect(x.note).toBe('[masked]');
      ids.push(x.id);
    }
    cursor = r.value.next_cursor ?? undefined;
  } while (cursor);
  const expected =
    await f.db`SELECT id FROM transaction_drafts WHERE token_id=${write.id}`;
  expect(ids.sort()).toEqual(expected.map((r) => String(r.id)).sort());
  expect(new Set(ids).size).toBe(ids.length);
  const u = await client(unmasked.token);
  expect(JSON.stringify((await call(u, 'list_drafts')).value)).toContain(
    'DRAFT_PRIVATE_NOTE',
  );
  const r = await f.app.inject({
    url: `/api/ledgers/${ledger}/drafts`,
    headers: f.otherHeaders,
  });
  expect(r.statusCode).toBe(404);
  expect((await post(ids[0]!, 'approve', {}, f.otherHeaders)).statusCode).toBe(
    404,
  );
  const scoped = await patService(f.db).create(f.actor, {
    scope: 'draft',
    expires_in_days: 1,
    ledger_ids: [f.ledger],
  });
  const restricted = await client(scoped.token);
  expect(
    (
      await call(restricted, 'draft_transaction', {
        ledger_id: ledger,
        ...data(),
      })
    ).value.error,
  ).toBe('not_found');
  expect(
    (
      await call(restricted, 'suggest_item', {
        ledger_id: ledger,
        text: 'test',
      })
    ).value.error,
  ).toBe('not_found');
  expect((await call(restricted, 'list_drafts')).value.items).toEqual([]);
});
it('suggestions use only allowed own history, frequency/recency and at most five item metadata records', async () => {
  const c = await client();
  const payee = await namedRecordService(f.db, 'payees').create(
    f.actor,
    ledger,
    { name: '合成建議對象' },
  );
  const a = await transactionService(f.db).create(f.actor, ledger, {
    ...data(),
    memo: 'SUGGEST_PRIVATE_HISTORY',
    payee_id: payee.id,
  });
  await transactionService(f.db).create(f.actor, ledger, {
    ...data(),
    memo: 'SUGGEST_PRIVATE_HISTORY',
    payee_id: payee.id,
  });
  await f.db`UPDATE transactions SET created_at=created_at-interval '1 day' WHERE id=${a.id}`;
  for (let i = 0; i < 6; i++) {
    const x = (
      await itemService(f.db).create(f.actor, ledger, {
        name: '其他建議' + i,
        kind: 'expense',
        currency: 'TWD',
      })
    ).id;
    await transactionService(f.db).create(f.actor, ledger, {
      ...data(),
      memo: 'SUGGEST_PRIVATE_HISTORY',
      entries: [
        { item_id: cash, amount: '-1' },
        { item_id: x, amount: '1' },
      ],
    });
  }
  const r = await call(c, 'suggest_item', {
    ledger_id: ledger,
    text: 'SUGGEST_PRIVATE',
  });
  expect(r.value).toHaveLength(5);
  expect(r.value[0].id).toBe(cash);
  expect(r.value[1].id).toBe(expense);
  expect(JSON.stringify(r.value)).not.toContain('SUGGEST_PRIVATE_HISTORY');
  expect(
    (await call(c, 'suggest_item', { ledger_id: ledger, text: '合成建議對象' }))
      .value,
  ).toHaveLength(2);
  await itemService(f.db).update(f.actor, ledger, expense, { archived: true });
  expect(
    (
      await call(c, 'suggest_item', {
        ledger_id: ledger,
        text: 'SUGGEST_PRIVATE',
      })
    ).value.map((i: { id: string }) => i.id),
  ).not.toContain(expense);
});
it('14-day boundary expires once with matching audit, worker also handles ledgers with no recurring rules', async () => {
  const d = await create(),
    young = await create();
  await f.db`UPDATE transaction_drafts SET created_at='2026-01-01T00:00:00Z' WHERE id=${String(d.id)}`;
  await f.db`UPDATE transaction_drafts SET created_at='2026-01-01T00:00:00.001Z' WHERE id=${String(young.id)}`;
  const terminal = await create();
  await post(String(terminal.id));
  await f.db`UPDATE transaction_drafts SET created_at='2026-01-01' WHERE id=${String(terminal.id)}`;
  await runRecurringWorker(f.db, new Date('2026-01-15T00:00:00Z'));
  expect((await draftService(f.db).get(f.actor, ledger, d.id)).status).toBe(
    'expired',
  );
  expect((await draftService(f.db).get(f.actor, ledger, young.id)).status).toBe(
    'pending',
  );
  expect(
    await expireTransactionDrafts(f.db, new Date('2026-01-15T00:00:00Z')),
  ).toBe(0);
  expect((await post(String(d.id))).json().error).toBe('draft_expired');
  expect(
    (await draftService(f.db).get(f.actor, ledger, terminal.id)).status,
  ).toBe('approved');
  expect((await post(String(terminal.id))).json().error).toBe(
    'draft_not_pending',
  );
  expect((await counts()).tx).toBe(1);
});
it('drafts are excluded from full and structure backups; approved source ID survives full restore', async () => {
  const pending = await create(),
    approved = await create();
  await post(String(approved.id));
  const backup = await backupService(f.db).download(f.actor, ledger);
  expect(JSON.stringify(backup)).not.toContain('transaction_drafts');
  expect(JSON.stringify(backup)).not.toContain('DRAFT_PRIVATE_NOTE');
  expect(JSON.stringify(backup)).not.toContain(String(pending.id));
  const full = await restoreService(f.db).confirm(f.actor, backup, {
    name: '合成草稿還原 ' + randomUUID(),
  });
  const [row] =
    await f.db`SELECT source_id FROM transactions WHERE ledger_id=${full.ledger.id} AND source_system='mcp-draft'`;
  expect(row!.source_id).toBe(approved.id);
  expect(
    await f.db`SELECT id FROM transaction_drafts WHERE ledger_id=${full.ledger.id}`,
  ).toHaveLength(0);
  const structure = await restoreService(f.db).confirm(f.actor, backup, {
    name: '合成草稿架構 ' + randomUUID(),
    mode: 'structure',
  });
  expect(
    await f.db`SELECT id FROM transaction_drafts WHERE ledger_id=${structure.ledger.id}`,
  ).toHaveLength(0);
});
it('all draft audit actions and SDK call rows never contain payload, notes, amounts, cookies or tokens', async () => {
  const c = await client();
  const [beforeAudit] =
    await f.db`SELECT count(*)::int n FROM audit_logs WHERE user_id=${f.actor} AND action='mcp.call'`;
  await call(c, 'draft_transaction', {
    ledger_id: ledger,
    ...data('98765.43'),
    note: 'DRAFT_PRIVATE_NOTE',
  });
  const [afterAudit] =
    await f.db`SELECT count(*)::int n FROM audit_logs WHERE user_id=${f.actor} AND action='mcp.call'`;
  expect(afterAudit!.n).toBe(beforeAudit!.n + 1);
  const a = await create(),
    b = await create(),
    e = await create();
  await post(String(a.id));
  await post(String(b.id), 'reject');
  await f.db`UPDATE transaction_drafts SET created_at='2020-01-01' WHERE id=${String(e.id)}`;
  await expireTransactionDrafts(f.db);
  const rows =
    await f.db`SELECT row_to_json(a)::text body FROM audit_logs a WHERE user_id=${f.actor}`;
  for (const action of [
    'draft.create',
    'draft.approve',
    'draft.reject',
    'draft.expire',
    'mcp.call',
  ])
    expect(rows.some((r) => r.body.includes(action))).toBe(true);
  for (const r of rows) {
    expect(r.body).not.toMatch(
      /DRAFT_PRIVATE|98765\.43|"(?:payload|preview|amount|note|memo|cookie|token_hash)"/,
    );
    expect(r.body).not.toContain(write.token);
    expect(r.body).not.toContain(f.headers.cookie);
  }
});
it('draft tokens are unusable immediately on revoke/expiry, and foreign-user ledgers are hidden', async () => {
  const s = patService(f.db),
    revoked = await s.create(f.actor, { scope: 'draft', expires_in_days: 1 });
  await s.revoke(f.actor, revoked.id);
  expect(await s.authenticate(revoked.token)).toBe(null);
  const expired = await s.create(f.actor, {
    scope: 'draft',
    expires_in_days: 1,
  });
  await f.db`UPDATE personal_access_tokens SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=${expired.id}`;
  expect(await s.authenticate(expired.token)).toBe(null);
  const foreignActor = (
    await f.app.inject({ url: '/api/me', headers: f.otherHeaders })
  ).json().user.id;
  const foreign = (
    await ledgerService(f.db).create(foreignActor, {
      name: '外人合成草稿 ' + randomUUID(),
    })
  ).id;
  const c = await client();
  expect(
    (await call(c, 'draft_transaction', { ledger_id: foreign, ...data() }))
      .value.error,
  ).toBe('not_found');
  expect(
    (await call(c, 'suggest_item', { ledger_id: foreign, text: '合成' })).value
      .error,
  ).toBe('not_found');
  const d = await create();
  expect(
    (
      await f.app.inject({
        url: `/api/ledgers/${ledger}/drafts/${String(d.id)}`,
        headers: f.otherHeaders,
      })
    ).statusCode,
  ).toBe(404);
});
it('a DB failure after entry creation rolls back transaction, entries and draft approval together', async () => {
  const d = await create();
  await f.db.unsafe(
    `CREATE FUNCTION synthetic_abort_draft_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure' USING ERRCODE='23514'; END $$; CREATE TRIGGER synthetic_abort_draft_approval BEFORE UPDATE OF status ON transaction_drafts FOR EACH ROW WHEN (NEW.status='approved') EXECUTE FUNCTION synthetic_abort_draft_approval()`,
  );
  try {
    expect((await post(String(d.id))).statusCode).toBe(400);
    expect((await counts()).tx).toBe(0);
    expect(
      await f.db`SELECT id FROM transaction_entries WHERE ledger_id=${ledger}`,
    ).toHaveLength(0);
    expect((await draftService(f.db).get(f.actor, ledger, d.id)).status).toBe(
      'pending',
    );
  } finally {
    await f.db.unsafe(
      'DROP TRIGGER synthetic_abort_draft_approval ON transaction_drafts; DROP FUNCTION synthetic_abort_draft_approval()',
    );
  }
});
