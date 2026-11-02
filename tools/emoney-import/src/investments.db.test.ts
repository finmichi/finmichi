// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  readFile,
  mkdtemp,
  stat,
  rm,
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from '../../../apps/server/test/catalog-fixture.js';
import {
  backupService,
  transactionService,
  securityService,
  securityReports,
  backupPayloadSha256,
} from '@finmichi/core';
import { restoreService } from '../../../packages/core/src/restores.js';
import { readBundle } from './bundle.js';
import { transform } from './transform.js';
import { mappingSchema } from './schema.js';
import { applyPlan } from './import.js';
import { reconcileDatabase } from './reconcile.js';
import { importInvestments, revertInvestments } from './investments.js';
let f: Awaited<ReturnType<typeof fixture>>;
const subject = 'synthetic-investments-' + randomUUID(),
  fixturePath = fileURLToPath(
    new URL('../fixtures-investments', import.meta.url),
  );
beforeAll(async () => {
  f = await fixture('investment-import-' + randomUUID());
  await f.db`UPDATE users SET oidc_subject=${subject} WHERE id=${f.actor}`;
});
afterAll(async () => {
  if (f) await f.close();
});
afterEach(async () => {
  if (f)
    await f.db`UPDATE users SET oidc_subject=${subject} WHERE id=${f.actor}`;
});
async function setup() {
  const bundle = await readBundle(fixturePath),
    mapping = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL('../investments.mapping.example.json', import.meta.url),
        ),
        'utf8',
      ),
    );
  // New app postings must target the synthetic leaf, not the historical bank root.
  mapping.settlement_item = '活存';
  mapping.deposit_items[0].payout_account = '活存';
  const p = transform(bundle, mappingSchema.parse({}), null);
  expect(p.report.errors).toEqual([]);
  const base = await applyPlan(f.db, p, {
    ownerSubject: subject,
    ledgerName: 'Synthetic investments ' + randomUUID(),
    allowDuplicateLedger: true,
  });
  const options = {
    ownerSubject: subject,
    ledgerId: base.ledger_id,
    now: new Date('2026-10-23T00:00:00Z'),
  };
  return { bundle, mapping, options, base };
}
async function journal(id: string) {
  return f.db`SELECT t.id,t.source_system,t.source_id,t.occurred_on::text,e.id entry_id,e.item_id,e.amount::text,e.base_amount::text,e.entry_position FROM transactions t JOIN transaction_entries e ON e.transaction_id=t.id WHERE t.ledger_id=${id} ORDER BY t.id,e.entry_position`;
}
async function counts(id: string) {
  return (
    await f.db`SELECT (SELECT count(*) FROM items WHERE ledger_id=${id})::int items,(SELECT count(*) FROM import_jobs WHERE ledger_id=${id})::int jobs,(SELECT count(*) FROM securities WHERE ledger_id=${id})::int securities,(SELECT count(*) FROM security_trades WHERE ledger_id=${id})::int trades,(SELECT count(*) FROM fixed_deposits WHERE ledger_id=${id})::int deposits,(SELECT count(*) FROM audit_logs WHERE user_id=${f.actor})::int audit`
  )[0]!;
}
it('dry-run zero writes; apply preserves every original journal row; provenance, audit and preconditions', async () => {
  const c = await setup(),
    before = await journal(c.options.ledgerId),
    n = await counts(c.options.ledgerId);
  const dry = await importInvestments(f.db, c.bundle, c.mapping, c.options);
  expect(dry.dry_run).toBe(true);
  expect(await counts(c.options.ledgerId)).toEqual(n);
  expect(dry.reconciliation.securities).toContainEqual({
    symbol: '00999',
    quantity: '100',
    cost: '910.00',
    average_cost: '9.1000',
    linked: 1,
    unlinked: 2,
  });
  await expect(
    importInvestments(
      f.db,
      { ...c.bundle, sourceSha256: 'f'.repeat(64) },
      c.mapping,
      c.options,
    ),
  ).rejects.toThrow('source_mismatch');
  const result = await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  expect(result.counts).toEqual({ securities: 2, trades: 4, deposits: 2 });
  expect(await journal(c.options.ledgerId)).toEqual(before);
  await expect(
    importInvestments(f.db, c.bundle, c.mapping, { ...c.options, apply: true }),
  ).rejects.toThrow('already_imported');
  const refs =
    await f.db`SELECT source_key,target_table FROM import_source_records WHERE import_job_id=${result.import_job_id!}`;
  expect(refs).toHaveLength(8);
  const trades =
    await f.db`SELECT origin,transaction_id,source_transaction_id FROM security_trades WHERE ledger_id=${c.options.ledgerId}`;
  expect(
    trades.every((t) => t.origin === 'emoney' && t.transaction_id === null),
  ).toBe(true);
  expect(trades.filter((t) => t.source_transaction_id)).toHaveLength(1);
  const audit =
    await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} AND action='emoney.import_investments'`;
  expect(audit.length).toBeGreaterThan(0);
  expect(JSON.stringify(audit)).not.toMatch(
    /BANK_NAME|SYNTHETIC|合成買進|1001|STOCK_MEMO|source_sha256/,
  );
});
it('database rejection rolls back newly created items, flags, securities, trades and job together', async () => {
  const c = await setup(),
    before = await counts(c.options.ledgerId);
  c.bundle.tables.get('STOCK_DATA')![2]!.STOCK_NOTE = 'x'.repeat(201);
  await expect(
    importInvestments(f.db, c.bundle, c.mapping, { ...c.options, apply: true }),
  ).rejects.toThrow();
  const after = await counts(c.options.ledgerId);
  expect({ ...after, audit: before.audit }).toEqual(before);
  const [item] =
    await f.db`SELECT securities FROM items WHERE ledger_id=${c.options.ledgerId} AND name='現金'`;
  expect(item!.securities).toBe(false);
});
it('revert removes imported investment records, restores flag and never changes accounting; repeat apply is serialized', async () => {
  const c = await setup(),
    before = await journal(c.options.ledgerId);
  const race = await Promise.allSettled([
    importInvestments(f.db, c.bundle, c.mapping, { ...c.options, apply: true }),
    importInvestments(f.db, c.bundle, c.mapping, { ...c.options, apply: true }),
  ]);
  expect(race.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  const result = race.find((x) => x.status === 'fulfilled')!;
  if (result.status !== 'fulfilled') throw new Error();
  const job = result.value.import_job_id!;
  await revertInvestments(f.db, job, c.options);
  expect((await counts(c.options.ledgerId)).trades).toBe(4);
  await revertInvestments(f.db, job, { ...c.options, apply: true });
  expect((await counts(c.options.ledgerId)).trades).toBe(0);
  expect(await journal(c.options.ledgerId)).toEqual(before);
  const [item] =
    await f.db`SELECT securities FROM items WHERE ledger_id=${c.options.ledgerId} AND name='現金'`;
  expect(item!.securities).toBe(false);
});
it('backup v8 remaps provenance, job metadata and source_transaction_id; missing source becomes null; older backup restores', async () => {
  const c = await setup();
  await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  const b = await backupService(f.db).download(f.actor, c.options.ledgerId);
  expect(b.schemaVersion).toBe(9);
  const restored = await restoreService(f.db).confirm(f.actor, b, {
    name: 'Synthetic restored investments ' + randomUUID(),
  });
  const links =
    await f.db`SELECT t.source_transaction_id,x.ledger_id FROM security_trades t JOIN transactions x ON x.id=t.source_transaction_id WHERE t.ledger_id=${restored.ledger.id}`;
  expect(links).toHaveLength(1);
  expect(links[0]!.ledger_id).toBe(restored.ledger.id);
  expect(links[0]!.source_transaction_id).not.toBe(
    b.tables.security_trades.find((t) => t.source_transaction_id)!
      .source_transaction_id,
  );
  const [job] =
    await f.db`SELECT id,report FROM import_jobs WHERE ledger_id=${restored.ledger.id} AND kind='emoney-investments'`;
  await revertInvestments(f.db, String(job!.id), {
    ...c.options,
    ledgerId: restored.ledger.id,
    apply: true,
  });
  const missing = structuredClone(b);
  missing.tables.security_trades.find(
    (t) => t.source_transaction_id,
  )!.source_transaction_id = randomUUID();
  missing.payloadSha256 = backupPayloadSha256(missing.tables);
  const restoredMissing = await restoreService(f.db).confirm(f.actor, missing, {
    name: 'Synthetic missing trace ' + randomUUID(),
  });
  const [first] =
    await f.db`SELECT source_transaction_id FROM security_trades WHERE ledger_id=${restoredMissing.ledger.id} ORDER BY trade_date,sequence`;
  expect(first!.source_transaction_id).toBeNull();
  const clean = await setup(),
    old = await backupService(f.db).download(f.actor, clean.options.ledgerId);
  const legacy = JSON.parse(JSON.stringify(old));
  legacy.schemaVersion = 7;
  legacy.format = 'life-ledger';
  for (const j of legacy.tables.import_jobs) delete j.kind;
  legacy.payloadSha256 = backupPayloadSha256(legacy.tables);
  await expect(
    restoreService(f.db).confirm(f.actor, legacy, {
      name: 'Synthetic legacy ' + randomUUID(),
    }),
  ).resolves.toHaveProperty('ledger.id');
});
it('emoney updates/deletes and historical replay never take over journal entries; app trades block revert', async () => {
  const c = await setup(),
    result = await importInvestments(f.db, c.bundle, c.mapping, {
      ...c.options,
      apply: true,
    }),
    before = await journal(c.options.ledgerId);
  const [sec] =
    await f.db`SELECT id FROM securities WHERE ledger_id=${c.options.ledgerId} AND symbol='00999'`;
  const rows =
    await f.db`SELECT * FROM security_trades WHERE security_id=${sec!.id} ORDER BY trade_date,sequence`;
  const first = rows[0]!;
  const d = {
    trade_type: 'buy',
    trade_date: '2026-01-02',
    quantity: '100',
    price: '12',
    fee: '1',
    tax: '0',
    settlement_item_id: first.settlement_item_id,
    expense_item_id: first.expense_item_id,
    gain_item_id: first.gain_item_id,
    note: 'synthetic changed',
  };
  const svc = securityService(f.db),
    p = await svc.preview(f.actor, c.options.ledgerId, sec!.id, {
      operation: 'update',
      trade_id: first.id,
      trade: d,
    });
  await svc.apply(
    f.actor,
    c.options.ledgerId,
    sec!.id,
    'update',
    { trade: d, preview_hash: p.preview_hash, confirm_recalculation: true },
    first.id,
  );
  expect(await journal(c.options.ledgerId)).toEqual(before);
  const [sell] =
    await f.db`SELECT cost_removed::text,origin,transaction_id FROM security_trades WHERE id=${rows[2]!.id}`;
  expect(sell).toEqual({
    cost_removed: '109.18',
    origin: 'emoney',
    transaction_id: null,
  });
  const appTrade = {
    ...d,
    trade_date: '2026-01-06',
    price: '10',
    quantity: '10',
  };
  const preview = await svc.preview(f.actor, c.options.ledgerId, sec!.id, {
    operation: 'create',
    trade: appTrade,
  });
  await svc.apply(f.actor, c.options.ledgerId, sec!.id, 'create', {
    trade: appTrade,
    preview_hash: preview.preview_hash,
    confirm_recalculation: true,
  });
  await expect(
    revertInvestments(f.db, result.import_job_id!, {
      ...c.options,
      apply: true,
    }),
  ).rejects.toThrow('revert_blocked');
  const history = await securityReports(f.db).history(
    f.actor,
    c.options.ledgerId,
    String(sec!.id),
  );
  expect(history.items.some((t) => t.origin === 'emoney')).toBe(true);
});
it('ordinary imported journal remains deletable; source FK clears; update is prohibited', async () => {
  const c = await setup();
  await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  const [t] =
    await f.db`SELECT source_transaction_id FROM security_trades WHERE ledger_id=${c.options.ledgerId} AND source_transaction_id IS NOT NULL`;
  const id = String(t!.source_transaction_id);
  const svc = transactionService(f.db),
    data = await svc.get(f.actor, c.options.ledgerId, id);
  await expect(
    svc.update(f.actor, c.options.ledgerId, id, {
      occurred_on: data.occurred_on,
      memo: 'synthetic',
      entries: data.entries.map((e) => ({
        item_id: e.item_id,
        amount: e.amount,
      })),
    }),
  ).rejects.toMatchObject({ code: 'security_item_requires_trade' });
  await svc.remove(f.actor, c.options.ledgerId, id);
  const links =
    await f.db`SELECT source_transaction_id FROM security_trades WHERE ledger_id=${c.options.ledgerId}`;
  expect(links.every((t) => t.source_transaction_id === null)).toBe(true);
});
it('CLI default dry-run writes private report only, emits no amounts or names; explicit apply and revert', async () => {
  const c = await setup(),
    dir = await mkdtemp(join(tmpdir(), 'synthetic-investments-cli-')),
    out = join(dir, 'report.json'),
    cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
    mapping = fileURLToPath(
      new URL('../investments.mapping.example.json', import.meta.url),
    );
  try {
    const args = [
      'investments',
      '--input',
      fixturePath,
      '--mapping',
      mapping,
      '--ledger-id',
      c.options.ledgerId,
      '--owner-subject',
      subject,
      '--out',
      out,
    ];
    const run = (args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
        encoding: 'utf8',
      });
    // Build images intentionally exclude .git. Make this path-boundary fixture
    // independent of the host checkout and of a git executable.
    const repository = join(dir, 'synthetic-repository');
    await mkdir(join(repository, '.git'), { recursive: true });
    await writeFile(join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const forbidden = join(repository, 'private-synthetic-report.json');
    const denied = run([...args.slice(0, -2), '--out', forbidden, '--apply']);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('report_path_not_private');
    await expect(stat(forbidden)).rejects.toMatchObject({ code: 'ENOENT' });
    const before = await counts(c.options.ledgerId),
      dry = run(args);
    expect(dry.status, dry.stderr).toBe(0);
    expect(await counts(c.options.ledgerId)).toEqual(before);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(dry.stdout + dry.stderr).not.toMatch(
      /BANK_NAME|SYNTHETIC|1001|910|合成/,
    );
    const apply = run([...args, '--apply']);
    expect(apply.status, apply.stderr).toBe(0);
    const result = JSON.parse(await readFile(out, 'utf8'));
    const revert = run([
      'investments',
      '--revert',
      result.import_job_id,
      '--ledger-id',
      c.options.ledgerId,
      '--owner-subject',
      subject,
      '--out',
      out,
      '--apply',
    ]);
    expect(revert.status, revert.stderr).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('postings/renewal and dividends independently block revert without partial removal', async () => {
  const { depositService, dividendService } = await import('@finmichi/core');
  for (const cause of ['deposit', 'dividend']) {
    const c = await setup(),
      result = await importInvestments(f.db, c.bundle, c.mapping, {
        ...c.options,
        apply: true,
      });
    if (cause === 'deposit') {
      const [d] =
        await f.db`SELECT id,maturity_on::text FROM fixed_deposits WHERE ledger_id=${c.options.ledgerId} AND status='active'`;
      const svc = depositService(f.db),
        amounts = {
          posted_on: String(d!.maturity_on),
          gross_interest: '0',
          renew: 'principal',
        };
      const p = await svc.preview(f.actor, c.options.ledgerId, String(d!.id), {
        operation: 'settlement',
        amounts,
      });
      await svc.apply(
        f.actor,
        c.options.ledgerId,
        String(d!.id),
        'settlement',
        { ...amounts, preview_hash: p.preview_hash },
      );
    } else {
      const [s] =
        await f.db`SELECT id FROM securities WHERE ledger_id=${c.options.ledgerId} AND symbol='00999'`;
      const svc = dividendService(f.db),
        dividend = {
          security_id: s!.id,
          ex_date: '2026-01-10',
          pay_date: '2026-01-11',
          per_share: '0',
          shares: '100',
          gross_amount: '0',
          net_amount: '0',
          stock_shares: '1',
          components: [],
        };
      const p = await svc.preview(f.actor, c.options.ledgerId, {
        operation: 'create',
        dividend,
      });
      await svc.apply(f.actor, c.options.ledgerId, 'create', {
        dividend,
        preview_hash: p.preview_hash,
        confirm_recalculation: true,
      });
    }
    const before = await counts(c.options.ledgerId);
    await expect(
      revertInvestments(f.db, result.import_job_id!, {
        ...c.options,
        apply: true,
      }),
    ).rejects.toMatchObject({
      code: 'revert_blocked',
      details: {
        reasons: expect.arrayContaining([
          cause === 'deposit' ? 'deposit_postings' : 'dividends',
        ]),
      },
    });
    const after = await counts(c.options.ledgerId);
    expect({ ...after, audit: before.audit }).toEqual(before);
  }
});
it('ownership, non-TWD and closed-period editing remain enforced', async () => {
  const c = await setup();
  await expect(
    importInvestments(f.db, c.bundle, c.mapping, {
      ...c.options,
      ledgerId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'not_found' });
  const { ledgerService } = await import('@finmichi/core');
  const foreign = await ledgerService(f.db).create(f.actor, {
    name: 'Synthetic USD ' + randomUUID(),
    base_currency: 'USD',
  });
  await expect(
    importInvestments(f.db, c.bundle, c.mapping, {
      ...c.options,
      ledgerId: foreign.id,
    }),
  ).rejects.toThrow('securities_require_twd_ledger');
  await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  await f.db`UPDATE ledgers SET locked_until='2026-01-31' WHERE id=${c.options.ledgerId}`;
  const [t] =
    await f.db`SELECT id,security_id FROM security_trades WHERE ledger_id=${c.options.ledgerId} ORDER BY trade_date LIMIT 1`;
  await expect(
    securityService(f.db).preview(f.actor, c.options.ledgerId, t!.security_id, {
      operation: 'delete',
      trade_id: t!.id,
    }),
  ).rejects.toMatchObject({ code: 'period_locked' });
});
it('holdings source is emoney, mixed after app buy, and app after a complete close followed by reopening', async () => {
  const c = await setup();
  await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  const [sec] =
    await f.db`SELECT id FROM securities WHERE ledger_id=${c.options.ledgerId} AND symbol='00999'`;
  const [t] =
    await f.db`SELECT * FROM security_trades WHERE security_id=${sec!.id} LIMIT 1`;
  const svc = securityService(f.db),
    report = () =>
      securityReports(f.db).holdings(f.actor, c.options.ledgerId, {
        as_of: '2026-02-01',
      });
  const origin = async () =>
    (await report()).items.find((h) => h.id === sec!.id)!.origin;
  expect(await origin()).toBe('emoney');
  async function apply(type: string, quantity: string, date: string) {
    const trade = {
      trade_type: type,
      quantity,
      trade_date: date,
      price: '20',
      fee: '0',
      tax: '0',
      settlement_item_id: t!.settlement_item_id,
      expense_item_id: t!.expense_item_id,
      gain_item_id: t!.gain_item_id,
    };
    const p = await svc.preview(f.actor, c.options.ledgerId, sec!.id, {
      operation: 'create',
      trade,
    });
    await svc.apply(f.actor, c.options.ledgerId, sec!.id, 'create', {
      trade,
      preview_hash: p.preview_hash,
      confirm_recalculation: true,
    });
  }
  await apply('buy', '10', '2026-01-10');
  expect(await origin()).toBe('mixed');
  await apply('sell', '110', '2026-01-11');
  expect(await origin()).toBe('mixed');
  const [sell] =
    await f.db`SELECT cost_removed::text,realized_gain::text FROM security_trades WHERE security_id=${sec!.id} AND origin='app' AND trade_type='sell'`;
  expect(sell).toEqual({ cost_removed: '1110.00', realized_gain: '1090.00' });
  await apply('buy', '1', '2026-01-12');
  expect(await origin()).toBe('app');
  expect(
    await securityReports(f.db).realized(f.actor, c.options.ledgerId),
  ).toMatchObject({
    booked_total: '1090.00',
    unbooked_total: '107.00',
    total: '1197.00',
  });
  const past = await securityReports(f.db).holdings(
    f.actor,
    c.options.ledgerId,
    { as_of: '2026-01-09' },
  );
  expect(past.items.find((h) => h.id === sec!.id)!.origin).toBe('emoney');
});

it('retroactive emoney edit recomputes only app cost/gain entries and preserves its cash/fee IDs and original imported journal', async () => {
  const c = await setup();
  await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  const importedBefore = await journal(c.options.ledgerId),
    originalIds = new Set(importedBefore.map((r) => String(r.id)));
  const [sec] =
      await f.db`SELECT id FROM securities WHERE ledger_id=${c.options.ledgerId} AND symbol='00999'`,
    [first] =
      await f.db`SELECT * FROM security_trades WHERE security_id=${sec!.id} ORDER BY trade_date,sequence LIMIT 1`;
  const svc = securityService(f.db),
    sell = {
      trade_type: 'sell',
      trade_date: '2026-01-10',
      quantity: '10',
      price: '20',
      fee: '1',
      tax: '1',
      settlement_item_id: first!.settlement_item_id,
      expense_item_id: first!.expense_item_id,
      gain_item_id: first!.gain_item_id,
    };
  const p = await svc.preview(f.actor, c.options.ledgerId, sec!.id, {
    operation: 'create',
    trade: sell,
  });
  const saved = await svc.apply(
    f.actor,
    c.options.ledgerId,
    sec!.id,
    'create',
    { trade: sell, preview_hash: p.preview_hash, confirm_recalculation: true },
  );
  const [app] =
    await f.db`SELECT transaction_id FROM security_trades WHERE id=${saved.trade_id!}`;
  const fixed = () =>
    f.db`SELECT id,item_id,amount::text,base_amount::text,entry_position FROM transaction_entries WHERE transaction_id=${app!.transaction_id} AND entry_position IN(0,2) ORDER BY entry_position`;
  const cashFee = await fixed(),
    buy = {
      ...sell,
      trade_type: 'buy',
      trade_date: '2026-01-02',
      quantity: '100',
      price: '12',
      tax: '0',
    };
  const preview = await svc.preview(f.actor, c.options.ledgerId, sec!.id, {
    operation: 'update',
    trade_id: first!.id,
    trade: buy,
  });
  expect(
    preview.recalculations.some((r) => r.trade_id === saved.trade_id),
  ).toBe(true);
  await svc.apply(
    f.actor,
    c.options.ledgerId,
    sec!.id,
    'update',
    {
      trade: buy,
      preview_hash: preview.preview_hash,
      confirm_recalculation: true,
    },
    first!.id,
  );
  expect(await fixed()).toEqual(cashFee);
  expect(
    (await journal(c.options.ledgerId)).filter((r) =>
      originalIds.has(String(r.id)),
    ),
  ).toEqual(importedBefore);
  const [after] =
    await f.db`SELECT cost_removed::text,realized_gain::text FROM security_trades WHERE id=${saved.trade_id!}`;
  expect(after).toEqual({ cost_removed: '109.18', realized_gain: '88.82' });
});

it('official MCP client exposes source through shared read service with masking, ledger scope and metadata-only audit', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(
    fileURLToPath(
      new URL('../../../apps/server/package.json', import.meta.url),
    ),
  );
  const { Client } = await import(
    require.resolve('@modelcontextprotocol/sdk/client/index.js')
  );
  const { StreamableHTTPClientTransport } = await import(
    require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')
  );
  const { patService } = await import('@finmichi/core');
  const c = await setup();
  await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  const pat = await patService(f.db).create(f.actor, {
    scope: 'read',
    expires_in_days: 1,
    ledger_ids: [c.options.ledgerId],
    mask_text: true,
  });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 }),
    client = new Client({ name: 'synthetic-investment-import', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(address + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + pat.token } },
      }),
    );
    const result = await client.callTool({
      name: 'get_report',
      arguments: {
        ledger_id: c.options.ledgerId,
        report: 'holdings',
        as_of: '2026-02-01',
      },
    });
    expect(result.isError).not.toBe(true);
    const text = result.content[0].text,
      data = JSON.parse(text);
    expect(
      data.items.every((r: { origin: string }) => r.origin === 'emoney'),
    ).toBe(true);
    expect(text).not.toMatch(/合成買進|STOCK_MEMO|BANK_NAME|SYNTHETIC/);
    const gains = await client.callTool({
      name: 'get_report',
      arguments: { ledger_id: c.options.ledgerId, report: 'realized-gains' },
    });
    expect(gains.isError).not.toBe(true);
    const gainData = JSON.parse(gains.content[0].text);
    expect(gainData).toMatchObject({
      booked_total: '0.00',
      unbooked_total: '107.00',
    });
    expect(
      gainData.items.every(
        (r: { origin: string; booked: boolean }) =>
          r.origin === 'emoney' && !r.booked,
      ),
    ).toBe(true);
    expect(gains.content[0].text).not.toMatch(
      /合成買進|STOCK_MEMO|BANK_NAME|SYNTHETIC/,
    );
    const denied = await client.callTool({
      name: 'get_report',
      arguments: { ledger_id: randomUUID(), report: 'holdings' },
    });
    expect(denied.isError).toBe(true);
    const audit =
      await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} AND action='mcp.call'`;
    expect(audit).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toMatch(/910\.00|1001\.00|STOCK_MEMO/);
    expect(JSON.stringify(audit)).not.toContain(pat.token);
  } finally {
    await client.close();
  }
});

it('DB enforces imported trade nonownership and same-ledger trace FK', async () => {
  const c = await setup(),
    other = await setup();
  await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  const [t] =
    await f.db`SELECT id,source_transaction_id FROM security_trades WHERE ledger_id=${c.options.ledgerId} AND source_transaction_id IS NOT NULL`;
  await expect(
    f.db`UPDATE security_trades SET transaction_id=source_transaction_id WHERE id=${t!.id}`,
  ).rejects.toMatchObject({ code: '23514' });
  const [foreign] =
    await f.db`SELECT id FROM transactions WHERE ledger_id=${other.options.ledgerId} LIMIT 1`;
  await expect(
    f.db`UPDATE security_trades SET source_transaction_id=${foreign!.id} WHERE id=${t!.id}`,
  ).rejects.toMatchObject({ code: '23503' });
  const [unchanged] =
    await f.db`SELECT source_transaction_id,transaction_id FROM security_trades WHERE id=${t!.id}`;
  expect(unchanged).toEqual({
    source_transaction_id: t!.source_transaction_id,
    transaction_id: null,
  });
});

it('rev1.14 keeps set_cost/cash_return gains booked by transaction presence, with HTTP report and journal agreement', async () => {
  const c = await setup();
  await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  const [t] =
    await f.db`SELECT * FROM security_trades WHERE ledger_id=${c.options.ledgerId} AND trade_type='sell'`;
  const svc = securityService(f.db);
  for (const fields of [
    { cost_mode: 'set_cost', cost_after: '1000', trade_date: '2026-01-10' },
    { cost_mode: 'cash_return', cash_amount: '1100', trade_date: '2026-01-11' },
    { cost_mode: 'keep', trade_date: '2026-01-12' },
  ]) {
    const trade = {
      trade_type: 'adjust',
      quantity_after: '100',
      settlement_item_id: t!.settlement_item_id,
      gain_item_id: t!.gain_item_id,
      ...fields,
    };
    const preview = await svc.preview(
      f.actor,
      c.options.ledgerId,
      t!.security_id,
      { operation: 'create', trade },
    );
    await svc.apply(f.actor, c.options.ledgerId, t!.security_id, 'create', {
      trade,
      preview_hash: preview.preview_hash,
      confirm_recalculation: true,
    });
  }
  const adjustments =
    await f.db`SELECT cost_mode,realized_gain::text,transaction_id FROM security_trades WHERE ledger_id=${c.options.ledgerId} AND trade_type='adjust' ORDER BY trade_date`;
  expect(
    adjustments.map((t) => [
      t.cost_mode,
      t.realized_gain,
      t.transaction_id !== null,
    ]),
  ).toEqual([
    ['set_cost', '90.00', true],
    ['cash_return', '100.00', true],
    ['keep', '0.00', false],
  ]);
  await f.db`UPDATE users SET oidc_subject='owner' WHERE id=${f.actor}`;
  const response = await f.app.inject({
    method: 'GET',
    url: `/api/ledgers/${c.options.ledgerId}/reports/realized-gains`,
    headers: f.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    booked_total: '190.00',
    unbooked_total: '107.00',
    total: '297.00',
  });
  expect(response.json().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        origin: 'app',
        booked: true,
        booked_total: '190.00',
        unbooked_total: '0.00',
      }),
      expect.objectContaining({
        origin: 'app',
        booked: false,
        booked_total: '0.00',
        unbooked_total: '0.00',
      }),
      expect.objectContaining({
        origin: 'emoney',
        booked: false,
        unbooked_total: '107.00',
      }),
    ]),
  );
  const [gain] =
    await f.db`SELECT round(-sum(base_amount),2)::text amount FROM transaction_entries WHERE ledger_id=${c.options.ledgerId} AND item_id=${t!.gain_item_id}`;
  expect(gain!.amount).toBe('190.00');
  const filtered = await securityReports(f.db).realized(
    f.actor,
    c.options.ledgerId,
    { date_from: '2026-01-11', date_to: '2026-01-11' },
  );
  expect(filtered).toMatchObject({
    booked_total: '100.00',
    unbooked_total: '0.00',
  });
});
it('rev1.14 refuses changing any emoney trade type in preview and write, with no journal mutation', async () => {
  const c = await setup();
  await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  const trades =
    await f.db`SELECT *,trade_date::text FROM security_trades WHERE ledger_id=${c.options.ledgerId}`;
  const before = await journal(c.options.ledgerId);
  await f.db`UPDATE users SET oidc_subject='owner' WHERE id=${f.actor}`;
  for (const t of trades) {
    for (const type of ['buy', 'sell', 'stock_dividend', 'adjust'].filter(
      (x) => x !== t.trade_type,
    )) {
      const trade = {
        trade_date: t.trade_date,
        trade_type: type,
        settlement_item_id: t.settlement_item_id,
        gain_item_id: t.gain_item_id,
        expense_item_id: t.expense_item_id,
        ...(type === 'adjust'
          ? { cost_mode: 'set_cost', quantity_after: '100', cost_after: '1000' }
          : type === 'stock_dividend'
            ? { quantity: '1' }
            : { quantity: '1', price: '1', fee: '0', tax: '0' }),
      };
      for (const write of [false, true]) {
        const r = await f.app.inject({
          method: write ? 'PUT' : 'POST',
          url: `/api/ledgers/${c.options.ledgerId}/securities/${t.security_id}/${write ? 'trades/' + t.id : 'trade-preview'}`,
          headers: f.headers,
          payload: write
            ? {
                trade,
                preview_hash: '0'.repeat(64),
                confirm_recalculation: true,
              }
            : { operation: 'update', trade_id: t.id, trade },
        });
        expect(r.statusCode, r.body).toBe(400);
        expect(r.json().error).toBe('emoney_trade_type_locked');
      }
    }
  }
  expect(await journal(c.options.ledgerId)).toEqual(before);
  await expect(
    f.db`UPDATE security_trades SET trade_type='adjust',cost_mode='keep',quantity_after=100 WHERE id=${trades[0]!.id}`,
  ).rejects.toMatchObject({ code: '23514' });
});
it('reverted create items are reused across repeated apply and full restore without extra items or journal changes', async () => {
  const c = await setup();
  const first = await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  const original = await journal(c.options.ledgerId);
  const itemCount = (await counts(c.options.ledgerId)).items;
  for (let turn = 0, job = first.import_job_id!; turn < 2; turn++) {
    await revertInvestments(f.db, job, { ...c.options, apply: true });
    const before = await counts(c.options.ledgerId);
    await importInvestments(f.db, c.bundle, c.mapping, c.options);
    expect(await counts(c.options.ledgerId)).toEqual(before);
    const result = await importInvestments(f.db, c.bundle, c.mapping, {
      ...c.options,
      apply: true,
    });
    job = result.import_job_id!;
    expect((await counts(c.options.ledgerId)).items).toBe(itemCount);
    expect(await journal(c.options.ledgerId)).toEqual(original);
  }
  const backup = await backupService(f.db).download(
    f.actor,
    c.options.ledgerId,
  );
  const restored = await restoreService(f.db).confirm(f.actor, backup, {
    name: 'Synthetic rerun restore ' + randomUUID(),
  });
  const options = { ...c.options, ledgerId: restored.ledger.id, apply: true };
  const [job] =
    await f.db`SELECT id FROM import_jobs WHERE ledger_id=${options.ledgerId} AND kind='emoney-investments' AND status='imported'`;
  await revertInvestments(f.db, String(job!.id), options);
  await expect(
    importInvestments(f.db, c.bundle, c.mapping, options),
  ).resolves.toHaveProperty('dry_run', false);
  expect((await counts(options.ledgerId)).items).toBe(itemCount);
});
it.each([
  'archived',
  'currency',
  'non_operating',
  'unproven',
  'other_ledger',
  'recreated',
])(
  'reverted create reuse rejects incompatible or unproven item: %s',
  async (change) => {
    const c = await setup();
    const result = await importInvestments(f.db, c.bundle, c.mapping, {
      ...c.options,
      apply: true,
    });
    await revertInvestments(f.db, result.import_job_id!, {
      ...c.options,
      apply: true,
    });
    const [item] =
      await f.db`SELECT id FROM items WHERE ledger_id=${c.options.ledgerId} AND name=${c.mapping.fee_item.create}`;
    if (change === 'archived')
      await f.db`UPDATE items SET archived=true WHERE id=${item!.id}`;
    if (change === 'currency')
      await f.db`UPDATE items SET currency='USD' WHERE id=${item!.id}`;
    if (change === 'non_operating')
      await f.db`UPDATE items SET non_operating=false WHERE id=${item!.id}`;
    if (change === 'unproven')
      await f.db`UPDATE import_jobs SET report=report-'created_item_ids' WHERE id=${result.import_job_id!}`;
    if (change === 'recreated') {
      await f.db`DELETE FROM items WHERE id=${item!.id}`;
      await f.db`INSERT INTO items(ledger_id,name,kind,currency,non_operating) VALUES(${c.options.ledgerId},${c.mapping.fee_item.create},'expense','TWD',true)`;
    }
    if (change === 'other_ledger') {
      const other = await setup();
      await f.db`UPDATE import_jobs SET ledger_id=${other.options.ledgerId} WHERE id=${result.import_job_id!}`;
    }
    const before = await counts(c.options.ledgerId);
    await expect(
      importInvestments(f.db, c.bundle, c.mapping, c.options),
    ).rejects.toThrow('mapping_item_invalid');
    expect(await counts(c.options.ledgerId)).toEqual(before);
  },
);

it('reconcile selects only the imported ledger job after investments import; ambiguity still fails', async () => {
  const c = await setup();
  const [ledger] =
    await f.db`SELECT name FROM ledgers WHERE id=${c.options.ledgerId}`;
  const name = String(ledger!.name);
  const before = await reconcileDatabase(f.db, subject, name);
  const originalItems = new Set(
    before.balances.map((b) => JSON.stringify([b.kind, b.name, b.currency])),
  );
  await importInvestments(f.db, c.bundle, c.mapping, {
    ...c.options,
    apply: true,
  });
  const after = await reconcileDatabase(f.db, subject, name);
  const added = after.balances.filter(
    (b) => !originalItems.has(JSON.stringify([b.kind, b.name, b.currency])),
  );
  expect(added.length).toBeGreaterThan(0);
  expect(
    added.every((b) => b.amount === '0.000000' && b.base_amount === '0.000000'),
  ).toBe(true);
  expect({
    ...after,
    balances: after.balances.filter((b) =>
      originalItems.has(JSON.stringify([b.kind, b.name, b.currency])),
    ),
  }).toEqual(before);
  // A non-imported ledger job is irrelevant; two imported ledger jobs remain ambiguous.
  const [extra] =
    await f.db`INSERT INTO import_jobs(ledger_id,source_system,source_sha256,status,kind,report)
    SELECT ledger_id,source_system,${'a'.repeat(64)},'failed','ledger',report FROM import_jobs
    WHERE ledger_id=${c.options.ledgerId} AND kind='ledger' RETURNING id`;
  expect(await reconcileDatabase(f.db, subject, name)).toEqual(after);
  await f.db`UPDATE import_jobs SET status='imported' WHERE id=${extra!.id}`;
  await expect(reconcileDatabase(f.db, subject, name)).rejects.toThrow(
    'emoney_job_not_unique',
  );
  await f.db`UPDATE import_jobs SET status='failed' WHERE ledger_id=${c.options.ledgerId} AND kind='ledger'`;
  await expect(reconcileDatabase(f.db, subject, name)).rejects.toThrow(
    'emoney_job_not_unique',
  );
});
