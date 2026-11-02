// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from '../test/catalog-fixture.js';
import {
  ledgerService,
  itemService,
  depositService,
  transactionService,
  backupService,
  restoreService,
  backupPayloadSha256,
  cashForecastService,
  forecastToday,
  patService,
} from '@finmichi/core';
import { monthDate } from '@finmichi/core/finance-calendar';
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture('deposits-' + randomUUID());
});
afterAll(async () => {
  if (f) await f.close();
});
async function setup(currency = 'TWD', patch = {}) {
  const l = await ledgerService(f.db).create(f.actor, {
      name: 'Synthetic deposit ' + randomUUID(),
    }),
    items = itemService(f.db);
  const asset = await items.create(f.actor, l.id, {
      name: 'Synthetic deposit asset',
      kind: 'asset',
      currency,
    }),
    bank = await items.create(f.actor, l.id, {
      name: 'Synthetic bank',
      kind: 'asset',
      currency,
    }),
    income = await items.create(f.actor, l.id, {
      name: 'Synthetic interest',
      kind: 'income',
      currency: 'TWD',
      non_operating: true,
    }),
    tax = await items.create(f.actor, l.id, {
      name: 'Synthetic tax',
      kind: 'expense',
      currency: 'TWD',
      non_operating: true,
    });
  const s = depositService(f.db),
    d = await s.save(f.actor, l.id, {
      item_id: asset.id,
      bank: 'Synthetic bank name',
      principal: '1000',
      annual_rate: '12',
      start_on: '2026-01-31',
      maturity_on: '2026-02-28',
      interest_basis: 'monthly',
      payout: 'monthly',
      payout_account_id: bank.id,
      interest_item_id: income.id,
      note: 'DEPOSIT_PRIVATE_NOTE',
      ...patch,
    });
  return { l, asset, bank, income, tax, s, d };
}
type C = Awaited<ReturnType<typeof setup>>;
const amounts = (patch = {}) => ({
  posted_on: '2026-02-28',
  gross_interest: '10',
  withholding_tax: '0',
  nhi_premium: '0',
  renew: 'none',
  ...patch,
});
async function post(
  c: C,
  operation: 'interest' | 'settlement',
  a = amounts(),
  id = c.d.id,
) {
  const p = await f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${c.l.id}/deposits/${id}/preview`,
    headers: f.headers,
    payload: { operation, amounts: a },
  });
  expect(p.statusCode, p.body).toBe(200);
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${c.l.id}/deposits/${id}/${operation === 'interest' ? 'interest' : 'settle'}`,
    headers: f.headers,
    payload: { ...a, preview_hash: p.json().preview_hash },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function revoke(c: C, id: string) {
  const p = await c.s.preview(f.actor, c.l.id, c.d.id, {
    operation: 'revoke',
    posting_id: id,
  });
  return c.s.apply(
    f.actor,
    c.l.id,
    c.d.id,
    'revoke',
    { preview_hash: p.preview_hash },
    id,
  );
}
async function legs(tx: string) {
  return f.db`SELECT e.item_id,round(e.amount,2)::text amount,round(e.base_amount,2)::text base FROM transaction_entries e WHERE transaction_id=${tx} ORDER BY entry_position`;
}
it.each(['none', 'principal', 'principal_and_interest'] as const)(
  'HTTP settle %s posts correct legs and renewals atomically',
  async (renew) => {
    const c = await setup(),
      r = await post(
        c,
        'settlement',
        amounts({
          renew,
          withholding_tax: '1',
          nhi_premium: '1',
          tax_item_id: c.tax.id,
        }),
      );
    const e = await legs(r.transaction_id);
    expect(e.map((x) => x.amount)).toEqual(
      renew === 'none'
        ? ['-1000.00', '1008.00', '-10.00', '2.00']
        : ['8.00', '-10.00', '2.00'],
    );
    expect(e[0]!.item_id).toBe(renew === 'principal' ? c.bank.id : c.asset.id);
    const ds = (await c.s.list(f.actor, c.l.id)).deposits;
    expect(ds.find((x) => x.id === c.d.id)!.status).toBe('matured');
    if (renew !== 'none') {
      const next = ds.find((x) => x.id === r.renewed_deposit_id)!;
      expect(next.principal).toBe(
        renew === 'principal' ? '1000.00' : '1008.00',
      );
      expect(next.renewed_from_id).toBe(c.d.id);
      expect([next.start_on, next.maturity_on]).toEqual([
        '2026-02-28',
        '2026-03-28',
      ]);
    } else expect(ds).toHaveLength(1);
    await revoke(c, r.id);
    expect((await c.s.list(f.actor, c.l.id)).deposits).toHaveLength(1);
    expect((await c.s.list(f.actor, c.l.id)).deposits[0]!.status).toBe(
      'active',
    );
    expect(await legs(r.transaction_id)).toHaveLength(0);
  },
);
it('monthly postings are unique under concurrent writes; cannot edit core settings or general managed transactions', async () => {
  const c = await setup(),
    a = amounts({ period_no: 1 }),
    p = await c.s.preview(f.actor, c.l.id, c.d.id, {
      operation: 'interest',
      amounts: a,
    });
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      c.s.apply(f.actor, c.l.id, c.d.id, 'interest', {
        ...a,
        preview_hash: p.preview_hash,
      }),
    ),
  );
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((x) => x.status === 'rejected')).toMatchObject({
    reason: { code: 'deposit_period_posted' },
  });
  const d = (await c.s.list(f.actor, c.l.id)).deposits[0]!,
    tx = d.postings[0]!.transaction_id!;
  for (const action of [
    () => c.s.save(f.actor, c.l.id, { principal: '2000' }, c.d.id),
    () => c.s.delete(f.actor, c.l.id, c.d.id),
  ])
    await expect(action()).rejects.toMatchObject({
      code: 'deposit_has_postings',
    });
  await c.s.save(
    f.actor,
    c.l.id,
    { bank: 'Updated synthetic', note: 'note' },
    c.d.id,
  );
  await expect(
    transactionService(f.db).update(f.actor, c.l.id, tx, { memo: 'x' }),
  ).rejects.toMatchObject({ code: 'deposit_managed_transaction' });
  await expect(
    transactionService(f.db).remove(f.actor, c.l.id, tx),
  ).rejects.toMatchObject({ code: 'deposit_managed_transaction' });
  await expect(
    c.s.preview(f.actor, c.l.id, c.d.id, {
      operation: 'settlement',
      amounts: amounts(),
    }),
  ).rejects.toMatchObject({ code: 'deposit_period_posted' });
  const r = await post(c, 'settlement', amounts({ gross_interest: '0' }));
  expect(r.transaction_id).not.toBeNull();
});
it('zero monthly postings and zero renewals have null transaction, revoke and lock still apply', async () => {
  for (const renew of ['principal', 'principal_and_interest']) {
    const c = await setup('USD', { annual_rate: '0' }),
      r = await post(c, 'settlement', amounts({ renew, gross_interest: '0' }));
    expect(r.transaction_id).toBeNull();
    expect(r.renewed_deposit_id).toBeTruthy();
    await revoke(c, r.id);
  }
  const c = await setup('TWD', { annual_rate: '0' }),
    r = await post(
      c,
      'interest',
      amounts({ period_no: 1, gross_interest: '0' }),
    );
  expect(r.transaction_id).toBeNull();
  await f.db`UPDATE ledgers SET locked_until='2026-02-28' WHERE id=${c.l.id}`;
  await expect(revoke(c, r.id)).rejects.toMatchObject({
    code: 'period_locked',
  });
  await expect(
    c.s.preview(f.actor, c.l.id, c.d.id, {
      operation: 'settlement',
      amounts: amounts({ gross_interest: '0', renew: 'principal' }),
    }),
  ).rejects.toMatchObject({ code: 'period_locked' });
  await f.db`UPDATE ledgers SET locked_until=NULL WHERE id=${c.l.id}`;
  await revoke(c, r.id);
});
it('renewal in use prevents revoke, early termination closes, full withholding retains two nonzero legs', async () => {
  const c = await setup(),
    r = await post(c, 'settlement', amounts({ renew: 'principal' }));
  await post(
    c,
    'interest',
    amounts({ period_no: 1, posted_on: '2026-03-28' }),
    r.renewed_deposit_id,
  );
  await expect(revoke(c, r.id)).rejects.toMatchObject({
    code: 'deposit_renewal_in_use',
  });
  const early = await setup();
  await post(
    early,
    'settlement',
    amounts({ posted_on: '2026-02-20', gross_interest: '3' }),
  );
  expect((await early.s.list(f.actor, early.l.id)).deposits[0]!.status).toBe(
    'closed',
  );
  const full = await setup(),
    p = await post(
      full,
      'interest',
      amounts({
        period_no: 1,
        withholding_tax: '10',
        tax_item_id: full.tax.id,
      }),
    );
  expect((await legs(p.transaction_id)).map((e) => e.amount)).toEqual([
    '-10.00',
    '10.00',
  ]);
});
it('foreign interest uses base income/tax legs, explicit rate and zero-sum base calculation', async () => {
  const c = await setup('USD'),
    r = await post(
      c,
      'interest',
      amounts({
        period_no: 1,
        withholding_tax: '1',
        tax_item_id: c.tax.id,
        exchange_rate: '32.5',
      }),
    );
  expect((await legs(r.transaction_id)).map((e) => [e.amount, e.base])).toEqual(
    [
      ['9.00', '292.50'],
      ['-325.00', '-325.00'],
      ['32.50', '32.50'],
    ],
  );
});
it('HTTP ownership, account/term/amount errors are explicit and preview stale cannot write', async () => {
  const c = await setup(),
    root = `/api/ledgers/${c.l.id}/deposits`;
  expect(
    (await f.app.inject({ method: 'GET', url: root, headers: f.otherHeaders }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: root + `/${c.d.id}/preview`,
        headers: f.otherHeaders,
        payload: { operation: 'interest', amounts: amounts({ period_no: 1 }) },
      })
    ).statusCode,
  ).toBe(404);
  const foreign = await itemService(f.db).create(f.actor, c.l.id, {
    name: 'Other currency',
    kind: 'asset',
    currency: 'USD',
  });
  await expect(
    c.s.save(f.actor, c.l.id, { payout_account_id: foreign.id }, c.d.id),
  ).rejects.toMatchObject({ code: 'deposit_currency_mismatch' });
  await expect(
    c.s.save(f.actor, c.l.id, { maturity_on: '2026-02-27' }, c.d.id),
  ).rejects.toMatchObject({ code: 'deposit_term_invalid' });
  for (const patch of [
    { gross_interest: '-1' },
    { withholding_tax: '11' },
    { nhi_premium: '-1' },
  ]) {
    const r = await f.app.inject({
      method: 'POST',
      url: root + `/${c.d.id}/preview`,
      headers: f.headers,
      payload: {
        operation: 'interest',
        amounts: amounts({ period_no: 1, ...patch }),
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('deposit_amount_invalid');
  }
  const a = amounts({ period_no: 1 }),
    p = await c.s.preview(f.actor, c.l.id, c.d.id, {
      operation: 'interest',
      amounts: a,
    });
  await c.s.save(f.actor, c.l.id, { annual_rate: '6' }, c.d.id);
  await expect(
    c.s.apply(f.actor, c.l.id, c.d.id, 'interest', {
      ...a,
      preview_hash: p.preview_hash,
    }),
  ).rejects.toMatchObject({ code: 'preview_stale' });
});
it('rev1.10 forecast projects each selected leg; processed and zero periods omitted; no database writes', async () => {
  const now = forecastToday(),
    c = await setup('TWD', {
      start_on: monthDate(now, -1),
      maturity_on: now,
      payout: 'at_maturity',
    }),
    equity = await itemService(f.db).create(f.actor, c.l.id, {
      name: 'Synthetic opening',
      kind: 'equity',
      currency: 'TWD',
    });
  await transactionService(f.db).create(f.actor, c.l.id, {
    occurred_on: monthDate(now, -1),
    entries: [
      { item_id: c.asset.id, amount: '1000' },
      { item_id: equity.id, amount: '-1000' },
    ],
  });
  const snap = async () =>
      JSON.stringify(
        await f.db`SELECT (SELECT count(*) FROM transactions)::int t,(SELECT count(*) FROM transaction_entries)::int e,(SELECT count(*) FROM audit_logs)::int a,(SELECT count(*) FROM fixed_deposits)::int d,(SELECT count(*) FROM deposit_postings)::int p`,
      ),
    before = await snap();
  for (const [accounts, opening, closing] of [
    [[c.asset.id, c.bank.id], '1000.00', '1010.00'],
    [[c.bank.id], '0.00', '1010.00'],
    [[c.asset.id], '1000.00', '0.00'],
  ] as const) {
    const r = await cashForecastService(f.db).forecast(f.actor, c.l.id, {
      accounts: [...accounts],
    });
    expect(r.opening_total).toBe(opening);
    expect(r.days[0]!.total).toBe(closing);
    expect(r.events.every((e) => e.source_type === 'deposit')).toBe(true);
  }
  expect(await snap()).toBe(before);
  await c.s.save(f.actor, c.l.id, { auto_renew: true }, c.d.id);
  const r = await cashForecastService(f.db).forecast(f.actor, c.l.id, {});
  expect(r.days[0]!.total).toBe('1010.00');
  expect(r.events).toHaveLength(1);
  await post(c, 'settlement', amounts({ posted_on: now }));
  expect(
    (
      await cashForecastService(f.db).forecast(f.actor, c.l.id, {})
    ).events.filter((e) => e.source_type === 'deposit'),
  ).toHaveLength(0);
  const usd = await setup('USD', {
    start_on: monthDate(now, -1),
    maturity_on: now,
  });
  expect(
    (
      await cashForecastService(f.db).forecast(f.actor, usd.l.id, {
        accounts: [usd.asset.id, usd.bank.id],
      })
    ).events,
  ).toHaveLength(0);
});
it('v6 full/structure remaps renewal/posting/source IDs and preserves null postings; v5 remains readable', async () => {
  const c = await setup('TWD', { annual_rate: '0' }),
    r = await post(
      c,
      'settlement',
      amounts({ renew: 'principal', gross_interest: '0' }),
    );
  await post(
    c,
    'interest',
    amounts({ period_no: 1, posted_on: '2026-03-28', gross_interest: '4' }),
    r.renewed_deposit_id,
  );
  const b = await backupService(f.db).download(f.actor, c.l.id);
  expect(b.schemaVersion).toBe(9);
  for (const mode of ['full', 'structure']) {
    const restored = await restoreService(f.db).confirm(f.actor, b, {
      mode,
      name: randomUUID(),
    });
    const again = await backupService(f.db).download(
      f.actor,
      restored.ledger.id,
    );
    expect(again.tables.fixed_deposits).toHaveLength(2);
    expect(
      again.tables.fixed_deposits.every(
        (d) => !b.tables.fixed_deposits.some((old) => old.id === d.id),
      ),
    ).toBe(true);
    expect(
      again.tables.fixed_deposits.find((d) => d.status === 'active')!
        .renewed_from_id,
    ).toBe(again.tables.fixed_deposits.find((d) => d.status === 'matured')!.id);
    expect(again.tables.deposit_postings).toHaveLength(mode === 'full' ? 2 : 0);
    if (mode === 'full') {
      expect(
        again.tables.deposit_postings.filter((p) => p.transaction_id === null),
      ).toHaveLength(1);
      expect(again.tables.transactions[0]!.source_id).toBe(
        again.tables.deposit_postings.find((p) => p.transaction_id !== null)!
          .id,
      );
    }
  }
  const legacy = structuredClone(b) as unknown as {
    schemaVersion: number;
    format: string;
    tables: Record<string, unknown>;
    counts: Record<string, number>;
    payloadSha256: string;
  };
  legacy.schemaVersion = 5;
  legacy.format = 'life-ledger';
  delete legacy.tables.reminder_settings;
  delete legacy.tables.reminder_reads;
  delete legacy.counts.reminder_settings;
  delete legacy.counts.reminder_reads;
  delete legacy.tables.fixed_deposits;
  delete legacy.tables.deposit_postings;
  delete legacy.counts.fixed_deposits;
  delete legacy.counts.deposit_postings;
  // A genuine legacy backup cannot contain deposit-managed transactions.
  legacy.tables.transactions = [];
  legacy.tables.transaction_entries = [];
  legacy.counts.transactions = 0;
  legacy.counts.transaction_entries = 0;
  legacy.payloadSha256 = backupPayloadSha256(legacy.tables);
  expect(
    (await restoreService(f.db).preview(f.actor, legacy)).source_schema_version,
  ).toBe(5);
});
it('failure after cash/new renewal rolls every product row back; DB rejects invalid null posting', async () => {
  const c = await setup(),
    a = amounts({ renew: 'principal_and_interest' }),
    p = await c.s.preview(f.actor, c.l.id, c.d.id, {
      operation: 'settlement',
      amounts: a,
    });
  await f.db.unsafe(
    `CREATE FUNCTION test_deposit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure';END $$;CREATE TRIGGER test_deposit_failure BEFORE INSERT ON deposit_postings FOR EACH ROW EXECUTE FUNCTION test_deposit_failure()`,
  );
  try {
    await expect(
      c.s.apply(f.actor, c.l.id, c.d.id, 'settlement', {
        ...a,
        preview_hash: p.preview_hash,
      }),
    ).rejects.toThrow();
    expect((await c.s.list(f.actor, c.l.id)).deposits).toHaveLength(1);
    expect(
      await f.db`SELECT id FROM transactions WHERE ledger_id=${c.l.id}`,
    ).toHaveLength(0);
  } finally {
    await f.db.unsafe(
      'DROP TRIGGER test_deposit_failure ON deposit_postings;DROP FUNCTION test_deposit_failure()',
    );
  }
  const r = await post(c, 'interest', amounts({ period_no: 1 }));
  await expect(
    f.db`UPDATE deposit_postings SET transaction_id=NULL WHERE id=${r.id}`,
  ).rejects.toThrow();
});
it('official MCP SDK deposits equals REST, scopes/masking and safe audit', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js'),
    { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const c = await setup(),
    pat = await patService(f.db).create(f.actor, {
      scope: 'read',
      expires_in_days: 1,
      ledger_ids: [c.l.id],
      mask_text: true,
    });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 }),
    client = new Client({ name: 'synthetic-deposits', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(address + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + pat.token } },
      }),
    );
    const response = await client.callTool({
      name: 'get_report',
      arguments: { ledger_id: c.l.id, report: 'deposits' },
    });
    expect(response.isError).not.toBe(true);
    const text = (response.content as { text: string }[])[0]!.text;
    expect(text).not.toContain('DEPOSIT_PRIVATE_NOTE');
    const result = JSON.parse(text),
      rest = (
        await f.app.inject({
          method: 'GET',
          url: `/api/ledgers/${c.l.id}/deposits`,
          headers: f.headers,
        })
      ).json();
    expect(result.totals).toEqual(rest.totals);
    expect(result.deposits[0].principal).toBe(rest.deposits[0].principal);
    expect(
      (
        await client.callTool({
          name: 'get_report',
          arguments: { ledger_id: f.ledger, report: 'deposits' },
        })
      ).isError,
    ).toBe(true);
    const audit =
      await f.db`SELECT row_to_json(a)::text body FROM audit_logs a WHERE user_id=${f.actor}`;
    for (const a of audit) {
      expect(a.body).not.toMatch(
        /DEPOSIT_PRIVATE_NOTE|gross_interest|withholding_tax|principal/,
      );
      expect(a.body).not.toContain(pat.token);
    }
  } finally {
    await client.close();
  }
});
it('reference FX fallback, readonly upcoming service, archived and protected account constraints', async () => {
  const c = await setup('USD');
  await f.db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES (${c.l.id},'2026-02-28','USD','TWD','32.5')`;
  const a = amounts({ period_no: 1 });
  const p = await c.s.preview(f.actor, c.l.id, c.d.id, {
    operation: 'interest',
    amounts: a,
  });
  expect(p.entries.find((e) => e.item_id === c.bank.id)?.exchange_rate).toBe(
    '32.5000000000',
  );
  await f.db`DELETE FROM exchange_rates WHERE ledger_id=${c.l.id}`;
  await f.db`INSERT INTO market_fx_rates(rate_date,currency,source,spot_buy,spot_sell) VALUES ('1901-02-28','USD','bot','30','32')`;
  const market = await c.s.preview(f.actor, c.l.id, c.d.id, {
    operation: 'interest',
    amounts: { ...a, posted_on: '1901-02-28' },
  });
  expect(
    market.entries.find((e) => e.item_id === c.bank.id)?.exchange_rate,
  ).toBe('31.0000000000');
  await f.db`DELETE FROM market_fx_rates WHERE rate_date='1901-02-28' AND currency='USD'`;
  await itemService(f.db).update(f.actor, c.l.id, c.bank.id, {
    archived: true,
  });
  await expect(
    c.s.preview(f.actor, c.l.id, c.d.id, { operation: 'interest', amounts: a }),
  ).rejects.toMatchObject({ code: 'archived_resource' });
  const now = forecastToday(),
    near = await setup('TWD', {
      start_on: monthDate(now, -1),
      maturity_on: now,
    });
  expect(
    (await near.s.upcoming(f.actor, near.l.id, 7)).map((d) => d.id),
  ).toEqual([near.d.id]);
  expect(() => near.s.upcoming(f.actor, near.l.id, 367)).toThrow(
    'invalid_input',
  );
  const security = await itemService(f.db).create(f.actor, near.l.id, {
    name: 'Protected security',
    kind: 'asset',
    currency: 'TWD',
    securities: true,
  });
  await expect(
    near.s.save(f.actor, near.l.id, { item_id: security.id }, near.d.id),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(
    f.db`UPDATE fixed_deposits SET item_id=${security.id} WHERE id=${near.d.id}`,
  ).rejects.toMatchObject({ code: '23514' });
  const backup = await backupService(f.db).download(f.actor, near.l.id);
  backup.tables.fixed_deposits[0]!.payout_account_id = randomUUID();
  backup.payloadSha256 = backupPayloadSha256(backup.tables);
  await expect(
    restoreService(f.db).confirm(f.actor, backup, { name: randomUUID() }),
  ).rejects.toMatchObject({ code: 'reference_invalid' });
});
