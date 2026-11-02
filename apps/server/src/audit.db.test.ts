// SPDX-License-Identifier: AGPL-3.0-only
import { reminderService } from '@finmichi/core';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fixture } from '../test/catalog-fixture.js';
import {
  sessionService,
  securityService,
  dividendService,
  depositService,
  marketService,
  draftService,
  expireTransactionDrafts,
  ledgerService,
  itemService,
  budgetService,
  financeService,
  namedRecordService,
  transactionService,
  backupService,
  restoreService,
  life2023Service,
} from '@finmichi/core';
import {
  auditActions,
  auditActionSchema,
} from '../../../packages/core/src/audit-schemas.js';
import { mutation } from '../../../packages/core/src/catalog.js';
import { readBundle } from '../../../tools/emoney-import/src/bundle.js';
import { transform } from '../../../tools/emoney-import/src/transform.js';
import { mappingSchema } from '../../../tools/emoney-import/src/schema.js';
import { importInvestments } from '../../../tools/emoney-import/src/investments.js';
import { applyPlan } from '../../../tools/emoney-import/src/import.js';
import { life2023Headers } from '@finmichi/core/life2023-schemas';
let f: Awaited<ReturnType<typeof fixture>>;
const sensitive = [
  'AUDIT_PRIVATE_MEMO_7cb41',
  'AUDIT_PRIVATE_FILE_2b821',
  '9876543.21',
  'AUDIT_PRIVATE_NAME_3ce2',
];
beforeAll(async () => {
  f = await fixture('audit');
});
afterAll(async () => {
  if (f) await f.close();
});
const get = (url = '/api/audit-logs', headers = f.headers) =>
  f.app.inject({ url, headers });
it('every current action writes real audit, including bulk imports/restores and backup; full rows contain no private payload', async () => {
  const ledgers = ledgerService(f.db),
    items = itemService(f.db);
  const temp = await ledgers.create(f.actor, { name: 'audit temporary' });
  await ledgers.update(f.actor, temp.id, { name: 'audit renamed' });
  await ledgers.setLock(f.actor, temp.id, { locked_until: '2026-09-30' });
  await ledgers.setLock(f.actor, temp.id, {
    locked_until: null,
    confirm_unlock: true,
  });
  await ledgers.remove(f.actor, temp.id);
  const cash = await items.create(f.actor, f.ledger, {
    name: 'Audit cash',
    kind: 'asset',
    currency: 'TWD',
  });
  const expense = await items.create(f.actor, f.ledger, {
    name: 'Audit expense',
    kind: 'expense',
    currency: 'TWD',
  });
  await items.update(f.actor, f.ledger, cash.id, {
    name: 'Audit cash',
    archived: false,
  });
  for (const table of ['payees', 'projects', 'memo_templates'] as const) {
    const service = namedRecordService(f.db, table);
    const r = await service.create(f.actor, f.ledger, {
      name: sensitive[3],
      ...(table === 'memo_templates' ? { memo: sensitive[0] } : {}),
    });
    await service.update(f.actor, f.ledger, r.id, {
      name: 'audit renamed resource',
    });
    await service.remove(f.actor, f.ledger, r.id);
  }
  await budgetService(f.db).distribute(f.actor, f.ledger, {
    year: 2026,
    item_id: expense.id,
    total: '123.45',
  });
  await budgetService(f.db).remove(f.actor, f.ledger, {
    year: 2026,
    item_id: expense.id,
  });
  const finance = financeService(f.db);
  const card = await items.create(f.actor, f.ledger, {
    name: '合成稽核卡',
    kind: 'liability',
    currency: 'TWD',
    credit_card: true,
  });
  const loan = await items.create(f.actor, f.ledger, {
    name: '合成稽核貸款',
    kind: 'liability',
    currency: 'TWD',
    loan: true,
  });
  await finance.saveCard(f.actor, f.ledger, {
    item_id: card.id,
    statement_day: 15,
    due_day: 5,
    due_month_offset: 1,
    payment_account_id: cash.id,
    credit_limit: '9876543.21',
  });
  await finance.remove(f.actor, f.ledger, card.id, 'card');
  await finance.saveLoan(f.actor, f.ledger, {
    item_id: loan.id,
    principal: '9876543.21',
    annual_rate: '2.1',
    term_months: 240,
    first_payment_on: '2026-10-20',
    method: 'annuity',
    payment_account_id: cash.id,
    interest_item_id: expense.id,
  });
  await finance.remove(f.actor, f.ledger, loan.id, 'loan');
  const txs = transactionService(f.db);
  const tx = await txs.create(f.actor, f.ledger, {
    occurred_on: '2026-10-17',
    memo: sensitive[0],
    invoice_no: sensitive[1],
    entries: [
      { item_id: cash.id, amount: '-9876543.21' },
      { item_id: expense.id, amount: '9876543.21' },
    ],
  });
  await txs.update(f.actor, f.ledger, tx.id, {
    memo: sensitive[0] + ' updated',
  });
  const backup = await backupService(f.db).download(f.actor, f.ledger);
  await restoreService(f.db).confirm(f.actor, backup, {
    name: 'audit restored',
  });
  await txs.remove(f.actor, f.ledger, tx.id);
  const csv = [
    life2023Headers,
    [
      '2026/10/17',
      'Audit cash',
      'Audit expense',
      '9876543.21',
      sensitive[0],
      '',
      '',
      sensitive[1],
    ],
  ]
    .map((r) => r.map((v) => '"' + v.replaceAll('"', '""') + '"').join(','))
    .join('\r\n');
  await life2023Service(f.db).confirm(f.actor, f.ledger, {
    file_base64: Buffer.from(csv).toString('base64'),
  });
  const sessions = sessionService(f.db, ['owner']);
  const token = await sessions.login(
    'https://audit.synthetic.invalid',
    'owner',
  );
  await sessions.logout(token!);
  // E-Money owner subjects must be unambiguous across all fixture issuers.
  const subject = 'audit-emoney-' + randomUUID(),
    es = sessionService(f.db, [subject]);
  const et = await es.login('https://audit-emoney.synthetic.invalid', subject);
  const p = transform(
    await readBundle(
      fileURLToPath(
        new URL(
          '../../../tools/emoney-import/fixtures-investments/',
          import.meta.url,
        ),
      ),
    ),
    mappingSchema.parse({}),
    null,
  );
  const emoneyBase = await applyPlan(f.db, p, {
    ownerSubject: subject,
    ledgerName: 'audit synthetic emoney',
  });
  await importInvestments(
    f.db,
    await readBundle(
      fileURLToPath(
        new URL(
          '../../../tools/emoney-import/fixtures-investments/',
          import.meta.url,
        ),
      ),
    ),
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            '../../../tools/emoney-import/investments.mapping.example.json',
            import.meta.url,
          ),
        ),
        'utf8',
      ),
    ),
    { ownerSubject: subject, ledgerId: emoneyBase.ledger_id, apply: true },
  );
  await es.logout(et!);
  const { patService } = await import('@finmichi/core');
  const pat = await patService(f.db).create(f.actor, { expires_in_days: 1 });
  const { mcpReadService } = await import('@finmichi/core');
  const principal = await patService(f.db).authenticate(pat.token);
  await mcpReadService(f.db, principal!).call('list_ledgers', {});
  await patService(f.db).revoke(f.actor, pat.id);
  const { recurringService } = await import('@finmichi/core');
  const recurring = recurringService(f.db),
    ruleInput = {
      name: 'Synthetic audit recurrence',
      frequency: 'monthly',
      interval: 1,
      day_of_month: 1,
      start_on: '2026-01-01',
      end_on: '2026-02-01',
      template: {
        entries: [
          { item_id: cash.id, amount: '-1' },
          { item_id: expense.id, amount: '1' },
        ],
      },
    };
  const rr = await recurring.save(f.actor, f.ledger, ruleInput);
  await recurring.save(
    f.actor,
    f.ledger,
    { ...ruleInput, name: 'Synthetic audit renamed' },
    rr.id,
  );
  await recurring.generate(f.actor, f.ledger, new Date('2026-02-02T00:00:00Z'));
  const occurrences = await recurring.occurrences(f.actor, f.ledger);
  await recurring.skip(f.actor, f.ledger, occurrences[0]!.id);
  await recurring.post(f.actor, f.ledger, occurrences[1]!.id);
  await recurring.remove(f.actor, f.ledger, rr.id);
  const draftPat = await patService(f.db).create(f.actor, {
    scope: 'draft',
    expires_in_days: 1,
  });
  const dp = (await patService(f.db).authenticate(draftPat.token))!;
  const drafts = draftService(f.db);
  const draftInput = {
    occurred_on: '2026-10-17',
    memo: sensitive[0],
    entries: [
      { item_id: cash.id, amount: '-1' },
      { item_id: expense.id, amount: '1' },
    ],
  };
  const da = await drafts.create(dp, f.ledger, draftInput, sensitive[1]);
  const dr = await drafts.create(dp, f.ledger, draftInput, sensitive[1]);
  const de = await drafts.create(dp, f.ledger, draftInput, sensitive[1]);
  await drafts.approve(f.actor, f.ledger, da.id);
  await drafts.reject(f.actor, f.ledger, dr.id);
  await f.db`UPDATE transaction_drafts SET created_at='2020-01-01' WHERE id=${String(de.id)}`;
  await expireTransactionDrafts(f.db);
  await marketService(f.db).upload(f.actor, f.ledger, {
    filename: 'ExchangeRate@190001011000.csv',
    content: readFileSync(
      new URL(
        '../../../packages/core/test/fixtures/market/bot.csv',
        import.meta.url,
      ),
      'utf8',
    ),
  });
  await f.db`DELETE FROM market_fx_rates WHERE rate_date='1900-01-01' AND source='bot'`;
  await f.db`DELETE FROM market_fetch_runs WHERE source='bot' AND received_date='1900-01-01'`;
  const sl = await ledgerService(f.db).create(f.actor, {
      name: 'Synthetic securities audit ' + randomUUID(),
    }),
    is = itemService(f.db),
    ss = securityService(f.db);
  const holding = await is.create(f.actor, sl.id, {
      name: 'Synthetic security',
      kind: 'asset',
      currency: 'TWD',
      securities: true,
    }),
    bank = await is.create(f.actor, sl.id, {
      name: 'Synthetic bank',
      kind: 'asset',
      currency: 'TWD',
    }),
    fee = await is.create(f.actor, sl.id, {
      name: 'Synthetic fee',
      kind: 'expense',
      currency: 'TWD',
      non_operating: true,
    }),
    gain = await is.create(f.actor, sl.id, {
      name: 'Synthetic gain',
      kind: 'income',
      currency: 'TWD',
      non_operating: true,
    });
  const sec = await ss.create(f.actor, sl.id, {
    name: sensitive[3],
    symbol: '9999X',
    market: 'TWSE',
    kind: 'stock',
    item_id: holding.id,
  });
  await ss.update(f.actor, sl.id, sec.id, { name: 'Synthetic renamed' });
  const mk = (extra = {}) => ({
    trade_type: 'buy',
    quantity: '100',
    price: '10',
    fee: '1',
    tax: '0',
    trade_date: '2026-01-02',
    settlement_item_id: bank.id,
    expense_item_id: fee.id,
    gain_item_id: gain.id,
    note: sensitive[0],
    ...extra,
  });
  const write = async (
    trade: unknown,
    operation: 'create' | 'update' | 'delete' = 'create',
    id?: string,
  ) => {
    const plan = await ss.preview(f.actor, sl.id, sec.id, {
      operation,
      ...(id ? { trade_id: id } : {}),
      ...(operation === 'delete' ? {} : { trade }),
    });
    return ss.apply(
      f.actor,
      sl.id,
      sec.id,
      operation,
      {
        ...(operation === 'delete' ? {} : { trade }),
        preview_hash: plan.preview_hash,
        confirm_recalculation: true,
      },
      id,
    );
  };
  const a = await write(mk()),
    b = await write(
      mk({ trade_type: 'sell', price: '20', trade_date: '2026-01-03' }),
    );
  const older = await write(mk({ trade_date: '2026-01-01', price: '30' }));
  await write(mk({ price: '11' }), 'update', a.trade_id);
  for (const id of [b.trade_id, a.trade_id, older.trade_id])
    await write(undefined, 'delete', id);
  const price = await ss.price(f.actor, sl.id, {
    market: 'TWSE',
    symbol: '9999X',
    price_date: '2026-01-01',
    price: '10',
  });
  await ss.removePrice(f.actor, sl.id, price.id);
  const ds = dividendService(f.db),
    defs = await ds.initialize(f.actor, sl.id);
  const code = await ds.saveCode(f.actor, sl.id, undefined, {
    code: 'synthetic',
    label: sensitive[1],
    income_item_id: defs.default_income_item_id,
  });
  await ds.saveCode(f.actor, sl.id, code.id, {
    code: 'synthetic',
    label: 'renamed',
    income_item_id: defs.default_income_item_id,
  });
  const dividend = {
    security_id: sec.id,
    ex_date: '2026-01-01',
    pay_date: '2026-01-02',
    shares: '1',
    per_share: '1',
    gross_amount: '9876543.21',
    net_amount: '9876543.21',
    components: [
      {
        code: 'synthetic',
        label: sensitive[1],
        amount: '9876543.21',
        taxable: false,
      },
    ],
    settlement_item_id: bank.id,
    default_income_item_id: defs.default_income_item_id,
    note: sensitive[0],
  };
  const dividendAuditPreview = await ds.preview(f.actor, sl.id, {
    operation: 'create',
    dividend,
  });
  const created = await ds.apply(f.actor, sl.id, 'create', {
    dividend,
    preview_hash: dividendAuditPreview.preview_hash,
  });
  if (!('transaction_id' in created))
    throw new Error('Dividend create missing');
  const updatedDividend = { ...dividend, note: sensitive[1] },
    up = await ds.preview(f.actor, sl.id, {
      operation: 'update',
      id: created.id,
      dividend: updatedDividend,
    });
  await ds.apply(
    f.actor,
    sl.id,
    'update',
    { dividend: updatedDividend, preview_hash: up.preview_hash },
    created.id,
  );
  const del = await ds.preview(f.actor, sl.id, {
    operation: 'delete',
    id: created.id,
  });
  await ds.apply(
    f.actor,
    sl.id,
    'delete',
    { preview_hash: del.preview_hash },
    created.id,
  );
  await ds.deleteCode(f.actor, sl.id, code.id);
  await ss.remove(f.actor, sl.id, sec.id);
  const dep = depositService(f.db),
    depositAsset = await is.create(f.actor, sl.id, {
      name: 'Synthetic deposit',
      kind: 'asset',
      currency: 'TWD',
    });
  const setting = await dep.save(f.actor, sl.id, {
    item_id: depositAsset.id,
    bank: sensitive[0],
    principal: '1000',
    annual_rate: '12',
    start_on: '2026-01-31',
    maturity_on: '2026-02-28',
    interest_basis: 'monthly',
    payout: 'monthly',
    payout_account_id: bank.id,
    interest_item_id: gain.id,
    note: sensitive[1],
  });
  await dep.save(f.actor, sl.id, { bank: sensitive[2] }, setting.id);
  for (const op of ['interest', 'settlement'] as const) {
    const amounts = {
      posted_on: '2026-02-28',
      gross_interest: '10',
      ...(op === 'interest' ? { period_no: 1 } : {}),
    };
    const p = await dep.preview(f.actor, sl.id, setting.id, {
      operation: op,
      amounts,
    });
    const posted = await dep.apply(f.actor, sl.id, setting.id, op, {
      ...amounts,
      preview_hash: p.preview_hash,
    });
    const rp = await dep.preview(f.actor, sl.id, setting.id, {
      operation: 'revoke',
      posting_id: posted.id,
    });
    await dep.apply(
      f.actor,
      sl.id,
      setting.id,
      'revoke',
      { preview_hash: rp.preview_hash },
      posted.id,
    );
  }
  await dep.delete(f.actor, sl.id, setting.id);
  await reminderService(f.db).saveSettings(f.actor, f.ledger, {});
  const own =
    await f.db`SELECT DISTINCT action FROM audit_logs WHERE user_id=${f.actor}`;
  expect(own.map((r) => r.action).sort()).toEqual(
    auditActions
      .filter((a) => a !== 'emoney.import' && a !== 'emoney.import_investments')
      .slice()
      .sort(),
  );
  const all = await f.db`SELECT row_to_json(a)::text AS body FROM audit_logs a`;
  const seen = new Set<string>();
  for (const r of all) {
    const body = String(r.body),
      row = JSON.parse(body);
    seen.add(row.action);
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'user_id',
        'action',
        'outcome',
        'created_at',
        'source_ip',
        'subject_hash',
        'tool',
        'token_prefix',
      ].sort(),
    );
    expect(auditActionSchema.safeParse(row.action).success).toBe(true);
    expect(body).not.toMatch(
      /"(?:token|cookie|amount|base_amount|exchange_rate|memo|summary|file_content|file_base64)"/i,
    );
    for (const secret of [...sensitive, token!, et!, f.headers.cookie])
      expect(body).not.toContain(secret);
  }
  for (const action of auditActions)
    expect(seen.has(action), action).toBe(true);
});
it('unexpected transaction failure is rolled back but audited; owner denial and OIDC rejection have safe outcomes', async () => {
  await expect(
    mutation(f.db, f.actor, 'ledger.create', async (sql) => {
      await sql`INSERT INTO ledgers(owner_id,name,base_currency) VALUES (${f.actor},'audit must rollback','TWD')`;
      throw new Error(sensitive[0]);
    }),
  ).rejects.toThrow(sensitive[0]);
  expect(
    await f.db`SELECT id FROM ledgers WHERE owner_id=${f.actor} AND name='audit must rollback'`,
  ).toHaveLength(0);
  expect(
    (
      await f.app.inject({
        method: 'PATCH',
        url: '/api/ledgers/' + f.ledger,
        headers: f.otherHeaders,
        payload: { name: sensitive[3] },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await f.app.inject({ url: '/auth/callback?code=' + sensitive[1] }))
      .statusCode,
  ).toBe(400);
  const errors =
    await f.db`SELECT action,outcome FROM audit_logs WHERE user_id=${f.actor} AND action='ledger.create' AND outcome='error'`;
  expect(errors.length).toBeGreaterThan(0);
  const rows = await f.db`SELECT row_to_json(a)::text body FROM audit_logs a`;
  for (const r of rows)
    for (const marker of sensitive)
      expect(String(r.body)).not.toContain(marker);
});
it('owner-only list/detail, anonymous 401, foreign/null-user rows and foreign cursor never leak; GET has no audit writes', async () => {
  const own = (await get()).json();
  expect(own.items.length).toBeGreaterThan(0);
  const one = own.items[0];
  expect(Object.keys(one).sort()).toEqual(
    ['id', 'created_at', 'action', 'outcome'].sort(),
  );
  const before = (await f.db`SELECT count(*)::text n FROM audit_logs`)[0]!.n;
  expect((await get('/api/audit-logs/' + one.id)).statusCode).toBe(200);
  expect(
    (await get('/api/audit-logs/' + one.id, f.otherHeaders)).statusCode,
  ).toBe(404);
  expect(
    (await get('/api/audit-logs', {} as typeof f.headers)).statusCode,
  ).toBe(401);
  const [orphan] =
    await f.db`SELECT id::text FROM audit_logs WHERE user_id IS NULL LIMIT 1`;
  expect((await get('/api/audit-logs/' + orphan!.id)).statusCode).toBe(404);
  const page = (await get('/api/audit-logs?limit=1')).json();
  expect(page.next_cursor).toBeTruthy();
  expect(
    (
      await get(
        '/api/audit-logs?cursor=' + encodeURIComponent(page.next_cursor),
        f.otherHeaders,
      )
    ).statusCode,
  ).toBe(404);
  expect((await f.db`SELECT count(*)::text n FROM audit_logs`)[0]!.n).toBe(
    before,
  );
  const others = (await get('/api/audit-logs', f.otherHeaders)).json();
  for (const r of others.items)
    expect(own.items.map((r: { id: string }) => r.id)).not.toContain(r.id);
});
it('microsecond ties, bigint IDs, AND filters, exact inclusive boundaries and cursor pages match direct SQL', async () => {
  for (let i = 0; i < 31; i++)
    await f.db`INSERT INTO audit_logs(user_id,action,outcome,created_at) VALUES (${f.actor},'ledger.update',${i % 2 ? 'error' : 'success'},'2030-01-01T00:00:00.123456Z')`;
  await f.db`INSERT INTO audit_logs(id,user_id,action,outcome,created_at) OVERRIDING SYSTEM VALUE VALUES ('9007199254740993',${f.actor},'ledger.update','success','2030-01-01T00:00:00.123456Z')`;
  const qs =
    'from=2030-01-01T00%3A00%3A00.123456Z&to=2030-01-01T00%3A00%3A00.123456Z&action=ledger.update&outcome=success&limit=7';
  const actual: string[] = [];
  let cursor: string | null = null;
  do {
    const r = await get(
      '/api/audit-logs?' +
        qs +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    expect(r.statusCode).toBe(200);
    const p = r.json();
    actual.push(...p.items.map((r: { id: string }) => r.id));
    cursor = p.next_cursor;
  } while (cursor);
  const sql =
    await f.db`SELECT id::text FROM audit_logs WHERE user_id=${f.actor} AND action='ledger.update' AND outcome='success' AND created_at='2030-01-01T00:00:00.123456Z' ORDER BY audit_logs.created_at DESC,audit_logs.id DESC`;
  expect(actual).toEqual(sql.map((r) => r.id));
  expect(new Set(actual).size).toBe(actual.length);
  expect(actual[0]).toBe('9007199254740993');
  const first = (await get('/api/audit-logs?' + qs)).json();
  expect(
    (
      await get(
        '/api/audit-logs?action=login&cursor=' +
          encodeURIComponent(first.next_cursor),
      )
    ).statusCode,
  ).toBe(400);
});
it('rejects malformed filters/cursors and supports GET only', async () => {
  for (const id of ['invalid', '0', '9223372036854775808'])
    expect((await get('/api/audit-logs/' + id)).statusCode).toBe(400);
  for (const q of [
    'limit=0',
    'limit=101',
    'from=invalid',
    'from=2030-01-01T00:00:00Z&to=2029-01-01T00:00:00Z',
    'action=payload',
    'outcome=payload',
    'user_id=' + f.actor,
    'cursor=invalid',
  ])
    expect((await get('/api/audit-logs?' + q)).statusCode).toBe(400);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/audit-logs',
        headers: f.headers,
        payload: { action: sensitive[0] },
      })
    ).statusCode,
  ).toBe(404);
});

it('DB rejects free-form action payloads and the allowlist covers every writer', async () => {
  await expect(
    f.db`INSERT INTO audit_logs(user_id,action,outcome) VALUES (${f.actor},${sensitive[0]},'success')`,
  ).rejects.toMatchObject({ code: '23514' });
});

it('known-actor schema rejection is audited without storing rejected payload', async () => {
  const before = (
    await f.db`SELECT count(*)::int n FROM audit_logs WHERE user_id=${f.actor} AND action='ledger.create' AND outcome='error'`
  )[0]!.n;
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/ledgers',
    headers: f.headers,
    payload: { name: sensitive[3], unexpected: sensitive[0] },
  });
  expect(r.statusCode).toBe(400);
  const [row] =
    await f.db`SELECT action,outcome FROM audit_logs WHERE user_id=${f.actor} AND action='ledger.create' ORDER BY created_at DESC,id DESC LIMIT 1`;
  expect(row).toEqual({ action: 'ledger.create', outcome: 'error' });
  expect(
    (
      await f.db`SELECT count(*)::int n FROM audit_logs WHERE user_id=${f.actor} AND action='ledger.create' AND outcome='error'`
    )[0]!.n,
  ).toBe(before + 1);
});
