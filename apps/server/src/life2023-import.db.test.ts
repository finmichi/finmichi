// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fixture } from '../test/catalog-fixture.js';
import { itemService, ledgerService, namedRecordService } from '@finmichi/core';
import type { Life2023Preview } from '@finmichi/core/life2023-schemas';
import { life2023Headers } from '@finmichi/core/life2023-schemas';
let f: Awaited<ReturnType<typeof fixture>>;
let cash: string, expense: string, income: string;
const csv = (rows: string[][]) =>
  [life2023Headers, ...rows]
    .map((row) => row.map((v) => '"' + v.replaceAll('"', '""') + '"').join(','))
    .join('\r\n') + '\r\n';
const file = (rows: string[][]) => ({
  file_base64: Buffer.from(csv(rows)).toString('base64'),
});
const row = (changes: Record<number, string> = {}) =>
  ['2026/10/17', '現金', '餐費', '1,000.00', '合成摘要', '', '', ''].map(
    (v, i) => changes[i] ?? v,
  );
const url = (ledger = f.ledger, op = 'preview') =>
  `/api/ledgers/${ledger}/imports/life2023/${op}`;
const post = (
  body: unknown,
  op = 'preview',
  ledger = f.ledger,
  headers = f.headers,
) =>
  f.app.inject({
    method: 'POST',
    url: url(ledger, op),
    headers,
    payload: body,
  });
beforeAll(async () => {
  f = await fixture('life2023-import');
  const items = itemService(f.db);
  cash = (
    await items.create(f.actor, f.ledger, {
      name: '現金',
      kind: 'asset',
      currency: 'TWD',
    })
  ).id;
  expense = (
    await items.create(f.actor, f.ledger, {
      name: '餐費',
      kind: 'expense',
      currency: 'TWD',
    })
  ).id;
  income = (
    await items.create(f.actor, f.ledger, {
      name: '餐費',
      kind: 'income',
      currency: 'TWD',
    })
  ).id;
});
afterAll(async () => {
  if (f) await f.close();
});
const mapped = (data: ReturnType<typeof file>, id = expense) => ({
  ...data,
  item_mappings: { 'destination:餐費': { mode: 'existing', id } },
});
it('preview parses UTF8 BOM and CP950 synthetic fixtures, preserves quoted multiline memo, does not write', async () => {
  const before = (
    await f.db`SELECT (SELECT count(*) FROM transactions WHERE ledger_id=${f.ledger}) AS transactions,(SELECT count(*) FROM import_jobs WHERE ledger_id=${f.ledger}) AS jobs,(SELECT count(*) FROM audit_logs) AS audits`
  )[0];
  for (const [name, encoding] of [
    ['life2023-utf8.csv', 'utf-8'],
    ['life2023-big5.csv', 'big5'],
  ]) {
    const bytes = await readFile('fixtures/life2023/' + name);
    const response = await post({ file_base64: bytes.toString('base64') });
    expect(response.statusCode).toBe(200);
    const p = response.json<Life2023Preview>();
    expect(p.encoding).toBe(encoding);
    expect(p.rows[0]!.amount).toBe('1234.50');
    expect(p.rows[0]!.cells[4]).toContain('"合成",逗號\n換行');
  }
  const after = (
    await f.db`SELECT (SELECT count(*) FROM transactions WHERE ledger_id=${f.ledger}) AS transactions,(SELECT count(*) FROM import_jobs WHERE ledger_id=${f.ledger}) AS jobs,(SELECT count(*) FROM audit_logs) AS audits`
  )[0];
  expect(after).toEqual(before);
});
it('same-name different kind is ambiguous; explicit mapping selects kind; raw file SHA is idempotent', async () => {
  const data = file([row()]);
  const p = (await post(data)).json<Life2023Preview>();
  expect(
    p.item_groups.find((g) => g.key === 'destination:餐費')!.candidates,
  ).toHaveLength(2);
  expect(p.importable_count).toBe(0);
  const prepared = mapped(data);
  expect((await post(prepared)).json<Life2023Preview>().importable_count).toBe(
    1,
  );
  const saved = await post(prepared, 'confirm');
  expect(saved.statusCode).toBe(201);
  expect(saved.json().imported_count).toBe(1);
  const [tx] =
    await f.db`SELECT id,kind FROM transactions WHERE ledger_id=${f.ledger}`;
  expect(tx!.kind).toBe('expense');
  const entries =
    await f.db`SELECT item_id,amount::text,base_amount::text FROM transaction_entries WHERE transaction_id=${String(tx!.id)} ORDER BY entry_position`;
  expect(entries).toMatchObject([
    { item_id: cash, amount: '-1000.000000', base_amount: '-1000.000000' },
    { item_id: expense, amount: '1000.000000', base_amount: '1000.000000' },
  ]);
  const duplicate = await post(prepared, 'confirm');
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json().error).toBe('already_imported');
  const [record] =
    await f.db`SELECT r.source_key,j.source_system,j.status FROM import_source_records r JOIN import_jobs j ON j.id=r.import_job_id WHERE r.target_id=${String(tx!.id)}`;
  expect(record).toMatchObject({
    source_key: '2',
    source_system: 'life2023-csv',
    status: 'imported',
  });
  const changed = {
    ...prepared,
    file_base64: Buffer.from(csv([row()]) + '\r\n').toString('base64'),
  };
  // Alternate date spelling changes bytes while retaining the same transaction semantics.
  changed.file_base64 = Buffer.from(csv([row({ 0: '2026-10-17' })])).toString(
    'base64',
  );
  const suspected = (await post(changed)).json<Life2023Preview>();
  expect(suspected.already_imported).toBe(false);
  expect(suspected.suspected_duplicate_count).toBe(1);
  expect((await post(changed, 'confirm')).statusCode).toBe(201);
});
it('invalid dates/amounts are row errors; skip decision persists and only valid rows are committed', async () => {
  const bad = ['2026/02/30', '115/10/17', '17-10-2026'];
  const rows = [
    ...bad.map((date) => row({ 0: date })),
    ...['0', '-1', 'x', '1.001'].map((amount) => row({ 3: amount })),
    row({ 4: '合成有效' }),
  ];
  const data = mapped(file(rows)),
    preview = (await post(data)).json<Life2023Preview>();
  expect(preview.error_count).toBe(7);
  expect(preview.importable_count).toBe(1);
  expect(preview.total_amount).toBe('1000.00');
  expect((await post(data, 'confirm')).json().error).toBe('import_has_errors');
  const saved = await post({ ...data, skip_invalid: true }, 'confirm');
  expect(saved.statusCode).toBe(201);
  const [job] =
    await f.db`SELECT report FROM import_jobs WHERE id=${saved.json().import_job_id}`;
  expect(job!.report.skip_invalid).toBe(true);
  expect(job!.report.skipped_lines).toHaveLength(7);
  expect(job!.report.imported_lines).toEqual([9]);
});
it('missing names require explicit kind; optional names default create or allow blank/existing', async () => {
  const data = file([
    row({ 1: '新現金', 2: '新支出', 5: '合成商店', 6: '合成計畫' }),
  ]);
  expect((await post(data)).json<Life2023Preview>().importable_count).toBe(0);
  const body = {
    ...data,
    item_mappings: {
      'source:新現金': {
        mode: 'create',
        data: { name: '新現金', kind: 'asset' },
      },
      'destination:新支出': {
        mode: 'create',
        data: { name: '新支出', kind: 'expense', fixed: true },
      },
    },
    project_mappings: { 合成計畫: { mode: 'blank' } },
  };
  const preview = (await post(body)).json<Life2023Preview>();
  expect(preview.pending_creates).toEqual({ items: 2, payees: 1, projects: 0 });
  expect((await post(body, 'confirm')).statusCode).toBe(201);
  const [payee] =
    await f.db`SELECT id FROM payees WHERE ledger_id=${f.ledger} AND name='合成商店'`;
  expect(payee).toBeDefined();
  const [project] =
    await f.db`SELECT id FROM projects WHERE ledger_id=${f.ledger} AND name='合成計畫'`;
  expect(project).toBeUndefined();
});
it('foreign and archived mapping rows are rejected, owner isolation and Origin apply to preview and confirm', async () => {
  const items = itemService(f.db),
    foreign = (
      await items.create(f.actor, f.ledger, {
        name: '美元',
        kind: 'asset',
        currency: 'USD',
      })
    ).id;
  const data = {
    ...mapped(file([row({ 1: '美元' })])),
    item_mappings: {
      'source:美元': { mode: 'existing', id: foreign },
      'destination:餐費': { mode: 'existing', id: expense },
    },
  };
  expect(
    (await post(data)).json<Life2023Preview>().rows[0]!.errors,
  ).toContainEqual({
    field: '來源項目',
    code: 'foreign_currency_not_supported',
  });
  await items.update(f.actor, f.ledger, foreign, { archived: true });
  expect(
    (await post(data)).json<Life2023Preview>().rows[0]!.errors,
  ).toContainEqual({ field: '來源項目', code: 'archived_resource' });
  for (const op of ['preview', 'confirm']) {
    expect(
      (await post(mapped(file([row()])), op, f.ledger, f.otherHeaders))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: url(f.ledger, op),
          headers: { origin: f.headers.origin },
          payload: mapped(file([row()])),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await post(mapped(file([row()])), op, f.ledger, {
          ...f.headers,
          origin: 'https://evil.invalid',
        })
      ).statusCode,
    ).toBe(403);
  }
  const otherLedger = await ledgerService(f.db).create(f.actor, {
    name: '合成另一帳本',
  });
  expect(
    (await post(mapped(file([row()]), income), 'preview', otherLedger.id))
      .statusCode,
  ).toBe(404);
});
it('a later row runtime failure rolls back prior rows, new catalogs and import job atomically', async () => {
  const ledger = (
    await ledgerService(f.db).create(f.actor, { name: '合成原子回滾' })
  ).id;
  // Synthetic DB trigger injects a failure only after a preceding row was written.
  await f.db.unsafe(
    `CREATE FUNCTION synthetic_import_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.memo='合成中途失敗' THEN RAISE EXCEPTION 'synthetic failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION synthetic_import_failure()`,
  );
  try {
    const data = {
      ...file([row({ 4: '合成前一列' }), row({ 4: '合成中途失敗' })]),
      item_mappings: {
        'source:現金': {
          mode: 'create',
          data: { name: '現金', kind: 'asset' },
        },
        'destination:餐費': {
          mode: 'create',
          data: { name: '餐費', kind: 'expense' },
        },
      },
    };
    expect((await post(data, 'confirm', ledger)).statusCode).toBe(400);
    for (const table of [
      'transactions',
      'items',
      'import_jobs',
      'import_source_records',
    ] as const)
      expect(
        (
          await f.db`SELECT count(*)::integer AS n FROM ${f.db(table)} WHERE ledger_id=${ledger}`
        )[0]!.n,
      ).toBe(0);
  } finally {
    await f.db.unsafe(
      'DROP TRIGGER synthetic_import_failure ON transactions; DROP FUNCTION synthetic_import_failure()',
    );
  }
});
it('locked periods and archived payee/project are revalidated before confirm; successful audit contains no content', async () => {
  const p = await namedRecordService(f.db, 'payees').create(f.actor, f.ledger, {
    name: '合成封存收付人',
  });
  const data = {
    ...mapped(file([row({ 5: p.name, 4: '不得記入稽核內容' })])),
    payee_mappings: { [p.name]: { mode: 'existing', id: p.id } },
  };
  expect((await post(data)).json<Life2023Preview>().importable_count).toBe(1);
  await namedRecordService(f.db, 'payees').update(f.actor, f.ledger, p.id, {
    archived: true,
  });
  expect((await post(data, 'confirm')).json().error).toBe('import_has_errors');
  await f.db`UPDATE ledgers SET locked_until='2026-10-17' WHERE id=${f.ledger}`;
  expect(
    (await post(mapped(file([row()])))).json<Life2023Preview>().rows[0]!.errors,
  ).toContainEqual({ field: '記錄日期', code: 'period_locked' });
  await f.db`UPDATE ledgers SET locked_until=NULL WHERE id=${f.ledger}`;
  const audits =
    await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} AND action='life2023.import'`;
  expect(audits.length).toBeGreaterThan(0);
  expect(JSON.stringify(audits)).not.toContain('不得記入稽核內容');
  expect(audits.some((a) => a.outcome === 'success')).toBe(true);
});
it('trimmed case-insensitive names map uniquely and concurrent confirms import exactly once', async () => {
  const ledger = (
    await ledgerService(f.db).create(f.actor, { name: '合成併發匯入' })
  ).id;
  const items = itemService(f.db);
  await items.create(f.actor, ledger, {
    name: 'Cash',
    kind: 'asset',
    currency: 'TWD',
  });
  await items.create(f.actor, ledger, {
    name: 'Food',
    kind: 'expense',
    currency: 'TWD',
  });
  const data = file([row({ 1: ' cash ', 2: 'FOOD', 4: '合成併發' })]);
  expect(
    (await post(data, 'preview', ledger)).json<Life2023Preview>()
      .importable_count,
  ).toBe(1);
  const responses = await Promise.all([
    post(data, 'confirm', ledger),
    post(data, 'confirm', ledger),
  ]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  expect(
    (
      await f.db`SELECT count(*)::integer AS n FROM transactions WHERE ledger_id=${ledger}`
    )[0]!.n,
  ).toBe(1);
});
it('an archived project is rejected and contradictory create choices are not silently merged', async () => {
  const project = await namedRecordService(f.db, 'projects').create(
    f.actor,
    f.ledger,
    { name: '合成封存計畫', archived: true },
  );
  const data = {
    ...mapped(file([row({ 6: project.name })])),
    project_mappings: { [project.name]: { mode: 'existing', id: project.id } },
  };
  expect(
    (await post(data)).json<Life2023Preview>().rows[0]!.errors,
  ).toContainEqual({ field: '專案代號', code: 'archived_resource' });
  const conflicting = {
    ...file([row({ 1: '同科目', 2: '同科目' })]),
    item_mappings: {
      'source:同科目': {
        mode: 'create',
        data: { name: '同科目', kind: 'asset', fixed: false },
      },
      'destination:同科目': {
        mode: 'create',
        data: { name: '同科目', kind: 'asset', fixed: true },
      },
    },
  };
  expect((await post(conflicting)).json().error).toBe('conflicting_mapping');
});
