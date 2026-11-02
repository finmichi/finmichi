// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from '../test/catalog-fixture.js';
import {
  itemService,
  namedRecordService,
  transactionService,
  backupService,
  backupPayloadSha256,
  queryService,
  reportService,
  life2023Service,
} from '@finmichi/core';
import type { LedgerBackup } from '@finmichi/core/backup-schemas';
import {
  backupTableNames,
  BACKUP_MAX_BYTES,
} from '@finmichi/core/backup-schemas';
let f: Awaited<ReturnType<typeof fixture>>, original: LedgerBackup, csv: string;
let cash: string, usd: string;
const refresh = (b: LedgerBackup) => {
  for (const k of backupTableNames) b.counts[k] = b.tables[k].length;
  b.payloadSha256 = backupPayloadSha256(b.tables);
  return b;
};
const copy = () => structuredClone(original);
const post = (
  b: unknown,
  op = 'preview',
  q: Record<string, string> = {},
  headers = f.headers,
) =>
  f.app.inject({
    method: 'POST',
    url: `/api/backup-restores/${op}?${new URLSearchParams(q)}`,
    headers,
    payload: b,
  });
beforeAll(async () => {
  f = await fixture('json-restore');
  const items = itemService(f.db);
  const root = (
    await items.create(f.actor, f.ledger, {
      name: '合成資產',
      kind: 'asset',
      currency: 'TWD',
    })
  ).id;
  cash = (
    await items.create(f.actor, f.ledger, {
      name: '合成現金',
      kind: 'asset',
      currency: 'TWD',
      parent_id: root,
    })
  ).id;
  usd = (
    await items.create(f.actor, f.ledger, {
      name: '合成美元',
      kind: 'asset',
      currency: 'USD',
      parent_id: root,
    })
  ).id;
  await items.create(f.actor, f.ledger, {
    name: '合成餐費',
    kind: 'expense',
    currency: 'TWD',
    fixed: true,
  });
  const foreignCost = (
    await items.create(f.actor, f.ledger, {
      name: '合成美元支出',
      kind: 'expense',
      currency: 'USD',
      non_operating: true,
    })
  ).id;
  const payee = await namedRecordService(f.db, 'payees').create(
      f.actor,
      f.ledger,
      { name: '合成商店' },
    ),
    project = await namedRecordService(f.db, 'projects').create(
      f.actor,
      f.ledger,
      { name: '合成專案' },
    );
  await namedRecordService(f.db, 'memo_templates').create(f.actor, f.ledger, {
    name: '合成模板',
    memo: '合成備註',
    archived: true,
  });
  const tx = transactionService(f.db);
  await tx.create(f.actor, f.ledger, {
    occurred_on: '2026-10-15',
    memo: '合成C',
    payee_id: payee.id,
    project_id: project.id,
    invoice_no: 'FAKE-C',
    entries: [
      { item_id: usd, amount: '-100', exchange_rate: '32.5' },
      { item_id: cash, amount: '4000' },
    ],
  });
  await tx.create(f.actor, f.ledger, {
    occurred_on: '2026-10-16',
    memo: '合成BD',
    entries: [
      { item_id: foreignCost, amount: '0.005', exchange_rate: '1' },
      { item_id: foreignCost, amount: '0.005', exchange_rate: '1' },
      { item_id: usd, amount: '-0.010', exchange_rate: '1' },
    ],
  });
  await f.db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate,as_of_source) VALUES (${f.ledger},'2026-10-15','USD','TWD',32.5123456789,true)`;
  csv =
    '記錄日期,來源項目,目的帳目,異動金額,摘要,收付人,專案代號,發票號碼\r\n2026/10/17,合成現金,合成餐費,12.34,"合成,往返",合成商店,合成專案,FAKE-A\r\n';
  await life2023Service(f.db).confirm(f.actor, f.ledger, {
    file_base64: Buffer.from(csv).toString('base64'),
  });
  const [job] =
    await f.db`SELECT id FROM import_jobs WHERE ledger_id=${f.ledger}`;
  for (const [source_key, target_table, target_id] of [
    ['rate', 'exchange_rates', '2026-10-15|USD|TWD'],
    ['missing', 'transactions', randomUUID()],
    ['deleted', 'items', 'deleted:' + randomUUID()],
    ['item', 'items', cash],
    ['payee', 'payees', payee.id],
    ['project', 'projects', project.id],
  ] as const)
    await f.db`INSERT INTO import_source_records(ledger_id,import_job_id,source_table,source_key,target_table,target_id) VALUES (${f.ledger},${job!.id},'synthetic',${source_key},${target_table},${target_id})`;
  const [external] =
    await f.db`SELECT id FROM transactions WHERE ledger_id=${f.ledger} AND memo='合成BD'`;
  await f.db`UPDATE transactions SET source_system='emoney-mdb',source_id=${'looks-like-' + String(job!.id)} WHERE id=${external!.id}`;
  await items.update(f.actor, f.ledger, usd, { archived: true });
  await namedRecordService(f.db, 'payees').update(f.actor, f.ledger, payee.id, {
    archived: true,
  });
  await f.db`UPDATE ledgers SET locked_until='2026-10-17' WHERE id=${f.ledger}`;
  original = await backupService(f.db).download(f.actor, f.ledger);
});
afterAll(async () => {
  if (f) await f.close();
});
async function comparedReports(source: string, target: string) {
  const service = reportService(f.db),
    q = { date_from: '2026-10-01', date_to: '2026-10-31' };
  const strip = (r: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(r).filter(
        ([key]) => !['ledger_id', 'generated_at'].includes(key),
      ),
    );
  const catalogs = await Promise.all([
    itemService(f.db).list(f.actor, source, { include_archived: 'true' }),
    itemService(f.db).list(f.actor, target, { include_archived: 'true' }),
  ]);
  const names = catalogs.map(
    (rows) => new Map(rows.map((i) => [i.id, i.kind + ':' + i.name])),
  );
  const normalized = (r: Record<string, unknown>, n: number) =>
    JSON.parse(JSON.stringify(strip(r)), (key, value) =>
      ['id', 'parent_id'].includes(key) && typeof value === 'string'
        ? (names[n]!.get(value) ?? value)
        : value,
    );
  for (const grain of ['day', 'month', 'quarter', 'year'])
    expect(
      normalized(
        (await service.income(f.actor, target, {
          ...q,
          grain,
        })) as unknown as Record<string, unknown>,
        1,
      ),
    ).toEqual(
      normalized(
        (await service.income(f.actor, source, {
          ...q,
          grain,
        })) as unknown as Record<string, unknown>,
        0,
      ),
    );
  for (const kind of ['income', 'expense']) {
    const a = normalized(
        (await service.category(f.actor, source, {
          ...q,
          kind,
        })) as unknown as Record<string, unknown>,
        0,
      ),
      b = normalized(
        (await service.category(f.actor, target, {
          ...q,
          kind,
        })) as unknown as Record<string, unknown>,
        1,
      );
    expect(b).toEqual(a);
  }
  expect(
    normalized(
      (await service.balance(f.actor, target, {
        as_of: q.date_to,
      })) as unknown as Record<string, unknown>,
      1,
    ),
  ).toEqual(
    normalized(
      (await service.balance(f.actor, source, {
        as_of: q.date_to,
      })) as unknown as Record<string, unknown>,
      0,
    ),
  );
}
it('preview has no writes, reports per-table counts/range and dangling provenance, defaults full and new name', async () => {
  const [before] =
    await f.db`SELECT (SELECT count(*) FROM ledgers)::integer AS ledgers,(SELECT count(*) FROM audit_logs)::integer AS audits`;
  const r = await post(original);
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({
    mode: 'full',
    base_currency: 'TWD',
    locked_until: '2026-10-17',
    counts: original.counts,
    date_range: { from: '2026-10-15', to: '2026-10-17' },
  });
  expect(r.json().default_name).toContain('（還原 ');
  expect(r.json().dangling_targets.transactions).toBe(1);
  expect(r.json().deleted_targets.items).toBe(1);
  expect(
    (
      await f.db`SELECT (SELECT count(*) FROM ledgers)::integer AS ledgers,(SELECT count(*) FROM audit_logs)::integer AS audits`
    )[0],
  ).toEqual(before);
});
it('full HTTP round trip remaps every ID/reference and preserves each exact stored entry, reports/query totals, metadata and import idempotence', async () => {
  const response = await post(original, 'confirm', { name: '合成完整還原' });
  expect(response.statusCode).toBe(201);
  const result = response.json(),
    target = result.ledger.id,
    map = result.id_map;
  const restored = await backupService(f.db).download(f.actor, target);
  expect(restored.ledger.locked_until).toBe(original.ledger.locked_until);
  for (const table of backupTableNames)
    expect(restored.counts[table]).toBe(original.counts[table]);
  for (const table of [
    'items',
    'payees',
    'projects',
    'memo_templates',
    'transactions',
    'transaction_entries',
    'import_jobs',
    'import_source_records',
  ] as const)
    for (const row of original.tables[table]) {
      expect(map[table][row.id]).toBeDefined();
      expect(map[table][row.id]).not.toBe(row.id);
      expect(
        restored.tables[table].some((r) => r.id === map[table][row.id]),
      ).toBe(true);
    }
  for (const e of original.tables.transaction_entries) {
    const r = restored.tables.transaction_entries.find(
      (r) => r.id === map.transaction_entries[e.id],
    )!;
    expect(r).toEqual({
      ...e,
      id: map.transaction_entries[e.id],
      ledger_id: target,
      transaction_id: map.transactions[e.transaction_id],
      item_id: map.items[e.item_id],
    });
  }
  for (const row of original.tables.items)
    expect(
      restored.tables.items.find((i) => i.id === map.items[row.id]),
    ).toEqual({
      ...row,
      id: map.items[row.id],
      ledger_id: target,
      parent_id: row.parent_id ? map.items[row.parent_id] : null,
    });
  for (const row of original.tables.transactions) {
    const r = restored.tables.transactions.find(
      (t) => t.id === map.transactions[row.id],
    )!;
    const source =
      row.source_system === 'life2023-csv'
        ? map.import_jobs[row.source_id!.split(':')[0]!] +
          ':' +
          row.source_id!.split(':')[1]
        : row.source_id;
    expect(r).toEqual({
      ...row,
      id: map.transactions[row.id],
      ledger_id: target,
      payee_id: row.payee_id ? map.payees[row.payee_id] : null,
      project_id: row.project_id ? map.projects[row.project_id] : null,
      source_id: source,
    });
  }
  for (const table of [
    'payees',
    'projects',
    'memo_templates',
    'import_jobs',
  ] as const)
    for (const row of original.tables[table])
      expect(
        restored.tables[table].find((r) => r.id === map[table][row.id]),
      ).toEqual({ ...row, id: map[table][row.id], ledger_id: target });
  expect(restored.tables.exchange_rates).toEqual(
    original.tables.exchange_rates.map((r) => ({ ...r, ledger_id: target })),
  );
  for (const row of original.tables.import_source_records) {
    const wanted = row.target_id.startsWith('deleted:')
      ? row.target_id
      : row.target_table === 'exchange_rates'
        ? row.target_id
        : (map[row.target_table][row.target_id] ?? 'deleted:' + row.target_id);
    expect(
      restored.tables.import_source_records.find(
        (r) => r.id === map.import_source_records[row.id],
      ),
    ).toEqual({
      ...row,
      id: map.import_source_records[row.id],
      ledger_id: target,
      import_job_id: map.import_jobs[row.import_job_id],
      target_id: wanted,
    });
  }
  const query = queryService(f.db),
    a = await query.search(f.actor, f.ledger, {}),
    b = await query.search(f.actor, target, {});
  expect(b.totals).toEqual(a.totals);
  await comparedReports(f.ledger, target);
  const rate = restored.tables.import_source_records.find(
    (r) => r.source_key === 'rate',
  )!;
  expect(rate.target_id).toBe('2026-10-15|USD|TWD');
  const missing = original.tables.import_source_records.find(
    (r) => r.source_key === 'missing',
  )!;
  expect(
    restored.tables.import_source_records.find(
      (r) => r.source_key === 'missing',
    )!.target_id,
  ).toBe('deleted:' + missing.target_id);
  for (const record of original.tables.import_source_records.filter((r) =>
    ['item', 'payee', 'project'].includes(r.source_key),
  ))
    expect(
      restored.tables.import_source_records.find(
        (r) => r.id === map.import_source_records[record.id],
      )!.target_id,
    ).toBe(map[record.target_table][record.target_id]);
  const duplicate = await f.app.inject({
    method: 'POST',
    url: `/api/ledgers/${target}/imports/life2023/confirm`,
    headers: f.headers,
    payload: { file_base64: Buffer.from(csv).toString('base64') },
  });
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json().error).toBe('already_imported');
  expect(
    (
      await f.app.inject({
        url: `/api/ledgers/${target}/backup.json`,
        headers: f.otherHeaders,
      })
    ).statusCode,
  ).toBe(404);
});
it('structure creates catalog only with cleared lock; ADR0006 CSV round trip reproduces all three reports', async () => {
  // Use only the base-currency two-leg source for the Life2023-format limitation.
  const { ledgerService, life2023Export } = await import('@finmichi/core');
  const source = (
    await ledgerService(f.db).create(f.actor, { name: '合成CSV結構來源' })
  ).id;
  const items = itemService(f.db),
    a = (
      await items.create(f.actor, source, {
        name: '合成結構現金',
        kind: 'asset',
        currency: 'TWD',
      })
    ).id,
    b = (
      await items.create(f.actor, source, {
        name: '合成結構支出',
        kind: 'expense',
        currency: 'TWD',
        fixed: true,
        non_operating: true,
      })
    ).id;
  await transactionService(f.db).create(f.actor, source, {
    occurred_on: '2026-10-17',
    memo: '合成結構往返',
    entries: [
      { item_id: a, amount: '-10' },
      { item_id: b, amount: '10' },
    ],
  });
  await f.db`UPDATE ledgers SET locked_until='2026-10-17' WHERE id=${source}`;
  const backup = await backupService(f.db).download(f.actor, source),
    preview = await post(backup, 'preview', { mode: 'structure' });
  expect(preview.json().locked_until).toBeNull();
  expect(preview.json().restore_counts.transactions).toBe(0);
  const response = await post(backup, 'confirm', {
    mode: 'structure',
    name: '合成結構還原',
  });
  expect(response.statusCode).toBe(201);
  const target = response.json().ledger.id;
  const structure = await backupService(f.db).download(f.actor, target);
  expect(structure.ledger.locked_until).toBeNull();
  for (const table of [
    'transactions',
    'transaction_entries',
    'exchange_rates',
    'import_jobs',
    'import_source_records',
  ] as const)
    expect(structure.tables[table]).toHaveLength(0);
  const exported = await life2023Export(f.db, f.actor, source, {});
  await life2023Service(f.db).confirm(f.actor, target, {
    file_base64: Buffer.from(exported.csv).toString('base64'),
  });
  await comparedReports(source, target);
});
it('amount tampering without checksum fails; refreshed checksum but nonzero sum is rejected by live DB trigger and every table rolls back', async () => {
  const backup = copy();
  backup.tables.transaction_entries[0]!.base_amount = '123.00';
  expect((await post(backup)).json().error).toBe('backup_checksum_mismatch');
  // Change a base-currency amount and base together so row invariants pass; only the deferred zero-sum trigger can reject it.
  const changed = copy(),
    entry = changed.tables.transaction_entries.find(
      (e) => e.currency === 'TWD' && !e.amount.startsWith('-'),
    )!;
  entry.amount = '999.000000';
  entry.base_amount = '999.000000';
  refresh(changed);
  const [before] = await f.db`SELECT count(*)::integer AS n FROM ledgers`;
  const response = await post(changed, 'confirm', { name: '合成必須回滾' });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe('invalid_input');
  expect((await f.db`SELECT count(*)::integer AS n FROM ledgers`)[0]).toEqual(
    before,
  );
  expect(
    await f.db`SELECT id FROM ledgers WHERE name='合成必須回滾'`,
  ).toHaveLength(0);
  const [triggers] =
    await f.db`SELECT count(*)::integer AS n FROM pg_trigger WHERE tgrelid IN ('transactions'::regclass,'transaction_entries'::regclass) AND tgname IN ('transactions_balanced','entries_balanced') AND tgenabled='O'`;
  expect(triggers!.n).toBe(2);
});
it('missing references list only the first20; duplicate IDs and cycles reject before writes', async () => {
  const b = copy();
  b.tables.transaction_entries = Array.from({ length: 25 }, (_, i) => ({
    ...b.tables.transaction_entries[0]!,
    id: randomUUID(),
    item_id: randomUUID(),
    entry_position: i,
  }));
  refresh(b);
  const r = await post(b);
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toBe('reference_invalid');
  expect(r.json().issues).toHaveLength(20);
  expect(r.json().issue_count).toBe(25);
  const duplicate = copy();
  duplicate.tables.items.push({ ...duplicate.tables.items[0]! });
  refresh(duplicate);
  expect((await post(duplicate)).json().error).toBe('reference_invalid');
  const cycle = copy();
  const roots = cycle.tables.items.filter((i) => i.kind === 'asset');
  roots[0]!.parent_id = roots[1]!.id;
  roots[1]!.parent_id = roots[0]!.id;
  refresh(cycle);
  expect((await post(cycle)).json().error).toBe('reference_invalid');
});
it.each(['ledger', 'row', 'tables', 'top'] as const)(
  'unknown fields %s are strict; numeric fields cannot be numbers',
  async (level) => {
    const b = copy();
    if (level === 'ledger') Object.assign(b.ledger, { owner_id: f.actor });
    if (level === 'row')
      Object.assign(b.tables.items[0]!, { secret: 'synthetic-placeholder' });
    if (level === 'tables') Object.assign(b.tables, { users: [] });
    if (level === 'top') Object.assign(b, { unexpected: true });
    expect((await post(b)).statusCode).toBe(400);
    const bad = copy();
    Object.assign(bad.tables.transaction_entries[0]!, { amount: 1 });
    expect((await post(bad)).statusCode).toBe(400);
  },
);
it('unsupported schema/counts, malformed rate target or missing Life2023 job reject; valid missing rate becomes deleted', async () => {
  expect((await post({ ...original, schemaVersion: 10 })).json().error).toBe(
    'backup_schema_unsupported',
  );
  const count = copy();
  count.counts.items++;
  expect((await post(count)).json().error).toBe('backup_count_mismatch');
  const invalid = copy();
  invalid.tables.import_source_records.find(
    (r) => r.source_key === 'rate',
  )!.target_id = '2026/10/15|USD|TWD';
  refresh(invalid);
  expect((await post(invalid)).json().error).toBe('reference_invalid');
  const nojob = copy();
  nojob.tables.transactions.find(
    (r) => r.source_system === 'life2023-csv',
  )!.source_id = randomUUID() + ':2';
  refresh(nojob);
  expect((await post(nojob)).json().error).toBe('reference_invalid');
  const missing = copy();
  missing.tables.import_source_records.find(
    (r) => r.source_key === 'rate',
  )!.target_id = '2026-10-16|USD|TWD';
  refresh(missing);
  expect((await post(missing)).json().dangling_targets.exchange_rates).toBe(1);
  const response = await post(missing, 'confirm', { name: '合成缺失匯率歷史' });
  expect(response.statusCode).toBe(201);
  const restored = await backupService(f.db).download(
    f.actor,
    response.json().ledger.id,
  );
  expect(
    restored.tables.import_source_records.find((r) => r.source_key === 'rate')!
      .target_id,
  ).toBe('deleted:2026-10-16|USD|TWD');
});
it('duplicate new name does not overwrite; restore owner is current actor; Origin/auth and size limits enforced', async () => {
  const b = copy();
  const response = await post(
    b,
    'confirm',
    { name: '合成另一使用者還原' },
    f.otherHeaders,
  );
  expect(response.statusCode).toBe(201);
  const target = response.json().ledger.id;
  expect(
    (
      await f.app.inject({
        url: `/api/ledgers/${target}/backup.json`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await f.app.inject({
        url: `/api/ledgers/${target}/backup.json`,
        headers: f.otherHeaders,
      })
    ).statusCode,
  ).toBe(200);
  const [before] = await f.db`SELECT count(*)::integer AS n FROM ledgers`;
  expect(
    (await post(b, 'confirm', { name: '合成另一使用者還原' }, f.otherHeaders))
      .statusCode,
  ).toBe(409);
  expect((await f.db`SELECT count(*)::integer AS n FROM ledgers`)[0]).toEqual(
    before,
  );
  expect(
    (
      await post(b, 'preview', {}, {
        origin: f.headers.origin,
      } as typeof f.headers)
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await post(
        b,
        'confirm',
        {},
        { ...f.headers, origin: 'https://evil.invalid' },
      )
    ).statusCode,
  ).toBe(403);
  const huge = JSON.stringify({ padding: 'x'.repeat(BACKUP_MAX_BYTES) });
  const oversized = await f.app.inject({
    method: 'POST',
    url: '/api/backup-restores/preview',
    headers: { ...f.headers, 'content-type': 'application/json' },
    payload: huge,
  });
  expect(oversized.statusCode).toBe(413);
  expect(oversized.json().error).toBe('backup_too_large');
});
it('delete marks provenance in the same transaction; locked delete leaves marker untouched', async () => {
  const { ledgerService } = await import('@finmichi/core');
  const ledger = (
    await ledgerService(f.db).create(f.actor, { name: '合成刪除來源標記' })
  ).id;
  const a = (
      await itemService(f.db).create(f.actor, ledger, {
        name: '合成現金',
        kind: 'asset',
        currency: 'TWD',
      })
    ).id,
    b = (
      await itemService(f.db).create(f.actor, ledger, {
        name: '合成支出',
        kind: 'expense',
        currency: 'TWD',
      })
    ).id;
  const csv =
    '記錄日期,來源項目,目的帳目,異動金額,摘要,收付人,專案代號,發票號碼\n2026/10/17,合成現金,合成支出,1.00,合成刪除,,,\n';
  await life2023Service(f.db).confirm(f.actor, ledger, {
    file_base64: Buffer.from(csv).toString('base64'),
  });
  const [tx] =
    await f.db`SELECT id FROM transactions WHERE ledger_id=${ledger}`;
  await f.db`UPDATE ledgers SET locked_until='2026-10-17' WHERE id=${ledger}`;
  await expect(
    transactionService(f.db).remove(f.actor, ledger, tx!.id),
  ).rejects.toMatchObject({ code: 'period_locked' });
  expect(
    (
      await f.db`SELECT target_id FROM import_source_records WHERE ledger_id=${ledger}`
    )[0]!.target_id,
  ).toBe(tx!.id);
  await f.db`UPDATE ledgers SET locked_until=NULL WHERE id=${ledger}`;
  await transactionService(f.db).remove(f.actor, ledger, tx!.id);
  expect(
    (
      await f.db`SELECT target_id FROM import_source_records WHERE ledger_id=${ledger}`
    )[0]!.target_id,
  ).toBe('deleted:' + tx!.id);
  expect(
    await f.db`SELECT id FROM transactions WHERE ledger_id=${ledger}`,
  ).toHaveLength(0);
  void a;
  void b;
});

it('uppercase UUIDs preserve original mapping keys; no restore option can overwrite the source ledger', async () => {
  const b = copy(),
    columns = new Set([
      'id',
      'ledger_id',
      'parent_id',
      'payee_id',
      'project_id',
      'transaction_id',
      'item_id',
      'import_job_id',
    ]);
  b.ledger.id = b.ledger.id.toUpperCase();
  for (const table of backupTableNames)
    for (const row of b.tables[table])
      for (const [key, value] of Object.entries(row))
        if (columns.has(key) && typeof value === 'string')
          Object.assign(row, { [key]: value.toUpperCase() });
  for (const row of b.tables.transactions)
    if (row.source_system === 'life2023-csv')
      row.source_id =
        row.source_id!.split(':')[0]!.toUpperCase() +
        ':' +
        row.source_id!.split(':')[1];
  for (const row of b.tables.import_source_records)
    if (
      row.target_table !== 'exchange_rates' &&
      !row.target_id.startsWith('deleted:')
    )
      row.target_id = row.target_id.toUpperCase();
  refresh(b);
  expect((await post(b)).statusCode).toBe(200);
  const response = await post(b, 'confirm', { name: '合成大寫識別碼還原' });
  expect(response.statusCode).toBe(201);
  for (const row of b.tables.items)
    expect(response.json().id_map.items[row.id]).toBeDefined();
  expect(
    (await post(original, 'confirm', { ledger_id: f.ledger })).statusCode,
  ).toBe(400);
  expect(
    (await post(original, 'confirm', { name: original.ledger.name }))
      .statusCode,
  ).toBe(409);
  expect(
    (await backupService(f.db).download(f.actor, f.ledger)).payloadSha256,
  ).toBe(original.payloadSha256);
});

it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
  'restores format/version %i with identical income/category/balance reports',
  async (version) => {
    const input = JSON.parse(JSON.stringify(original));
    input.schemaVersion = version;
    input.format = version < 9 ? 'life-ledger' : 'finmichi';
    const introduced: Record<string, number> = {
      recurring_rules: 2,
      recurring_occurrences: 2,
      budgets: 2,
      credit_card_settings: 3,
      loan_settings: 3,
      securities: 4,
      security_trades: 4,
      manual_prices: 4,
      income_codes: 5,
      dividends: 5,
      dividend_components: 5,
      fixed_deposits: 6,
      deposit_postings: 6,
      reminder_settings: 7,
      reminder_reads: 7,
    };
    for (const [table, since] of Object.entries(introduced)) {
      if (version >= since) continue;
      expect(input.tables[table]).toEqual([]);
      delete input.tables[table];
      delete input.counts[table];
    }
    if (version < 4)
      for (const item of input.tables.items) delete item.securities;
    if (version < 8)
      for (const job of input.tables.import_jobs) delete job.kind;
    input.payloadSha256 = backupPayloadSha256(input.tables);
    const response = await post(input, 'confirm', {
      name: `合成格式往返-v${version}`,
    });
    expect(response.statusCode).toBe(201);
    const ledger = response.json().ledger.id;
    await comparedReports(f.ledger, ledger);
    const roundTrip = await backupService(f.db).download(f.actor, ledger);
    expect(roundTrip.format).toBe('finmichi');
    expect(roundTrip.schemaVersion).toBe(9);
    expect(roundTrip.counts.transactions).toBe(original.counts.transactions);
    expect(
      roundTrip.tables.transaction_entries
        .map(({ amount, exchange_rate, base_amount, entry_position }) => ({
          amount,
          exchange_rate,
          base_amount,
          entry_position,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual(
      original.tables.transaction_entries
        .map(({ amount, exchange_rate, base_amount, entry_position }) => ({
          amount,
          exchange_rate,
          base_amount,
          entry_position,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  },
);
