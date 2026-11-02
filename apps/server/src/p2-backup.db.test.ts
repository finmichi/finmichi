// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from '../test/catalog-fixture.js';
import {
  itemService,
  namedRecordService,
  recurringService,
  transactionService,
  backupService,
  backupPayloadSha256,
  reportService,
  queryService,
  budgetService,
  life2023Service,
} from '@finmichi/core';
import {
  backupTableNames,
  legacyBackupTableNames,
  type LedgerBackup,
} from '@finmichi/core/backup-schemas';
let f: Awaited<ReturnType<typeof fixture>>, original: LedgerBackup;
const post = (b: unknown, mode = 'full', name = '合成P2還原', op = 'confirm') =>
  f.app.inject({
    method: 'POST',
    url: `/api/backup-restores/${op}?${new URLSearchParams({ mode, name })}`,
    headers: f.headers,
    payload: b,
  });
function refresh(b: LedgerBackup) {
  for (const k of backupTableNames) b.counts[k] = b.tables[k].length;
  b.payloadSha256 = backupPayloadSha256(b.tables);
  return b;
}
function normalize(value: unknown, ids: Record<string, string>): unknown {
  if (typeof value === 'string') {
    if (ids[value]) return ids[value];
    const prefix = value.slice(0, 36);
    return ids[prefix] && value[36] === ':'
      ? ids[prefix] + value.slice(36)
      : value;
  }
  if (Array.isArray(value))
    return value
      .map((v) => normalize(v, ids))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !['generated_at'].includes(k))
        .map(([k, v]) => [k, normalize(v, ids)]),
    );
  return value;
}
beforeAll(async () => {
  f = await fixture('p2-backup');
  const items = itemService(f.db);
  const cash = await items.create(f.actor, f.ledger, {
      name: '合成現金',
      kind: 'asset',
      currency: 'TWD',
    }),
    food = await items.create(f.actor, f.ledger, {
      name: '合成餐費',
      kind: 'expense',
      currency: 'TWD',
    });
  const payee = await namedRecordService(f.db, 'payees').create(
      f.actor,
      f.ledger,
      { name: '合成店' },
    ),
    project = await namedRecordService(f.db, 'projects').create(
      f.actor,
      f.ledger,
      { name: '合成案' },
    );
  const s = recurringService(f.db),
    r = await s.save(f.actor, f.ledger, {
      name: '合成P2規則',
      frequency: 'monthly',
      day_of_month: 31,
      start_on: '2026-01-01',
      end_on: '2026-05-31',
      template: {
        memo: '合成P2摘要',
        payee_id: payee.id,
        project_id: project.id,
        entries: [
          { item_id: cash.id, amount: '-1000.37' },
          { item_id: food.id, amount: '1000.37' },
        ],
      },
    });
  await s.generate(f.actor, f.ledger, new Date('2026-05-31T04:00:00Z'));
  const rows = await s.occurrences(f.actor, f.ledger);
  expect(rows).toHaveLength(5);
  await s.post(f.actor, f.ledger, rows[0]!.id);
  await s.skip(f.actor, f.ledger, rows[1]!.id);
  await f.db`UPDATE ledgers SET locked_until='2026-03-31' WHERE id=${f.ledger}`;
  expect((await s.post(f.actor, f.ledger, rows[2]!.id)).status).toBe('failed');
  await budgetService(f.db).distribute(f.actor, f.ledger, {
    year: 2026,
    item_id: food.id,
    total: '12000.06',
  });
  await f.db`INSERT INTO recurring_worker_runs(ledger_id,status) VALUES (${f.ledger},'success')`;
  original = await backupService(f.db).download(f.actor, f.ledger);
  expect(original.tables.recurring_rules[0]!.id).toBe(r.id);
});
afterAll(async () => {
  if (f) await f.close();
});
it('v2 full round trip preserves P2 templates, every status/link/budget and reports/query while regenerating IDs', async () => {
  expect(original.schemaVersion).toBe(9);
  expect(original.counts.recurring_occurrences).toBe(5);
  expect(original.counts.budgets).toBe(12);
  expect(Object.keys(original.tables)).not.toContain('recurring_worker_runs');
  const p = await post(original, 'full', '合成P2預覽', 'preview');
  expect(p.statusCode).toBe(200);
  expect(p.json().restore_counts).toEqual(original.counts);
  const res = await post(original);
  expect(res.statusCode, res.body).toBe(201);
  const r = res.json(),
    target = r.ledger.id as string;
  const b = await backupService(f.db).download(f.actor, target),
    ids: Record<string, string> = {};
  for (const map of Object.values(r.id_map) as Record<string, string>[])
    for (const [old, n] of Object.entries(map)) {
      expect(n).not.toBe(old);
      ids[n] = old;
    }
  expect(normalize(b.tables, ids)).toEqual(normalize(original.tables, {}));
  const [workers] =
    await f.db`SELECT count(*)::int n FROM recurring_worker_runs WHERE ledger_id=${target}`;
  expect(workers!.n).toBe(0);
  const svc = reportService(f.db),
    q = { date_from: '2026-01-01', date_to: '2026-12-31' };
  for (const [a, c] of [
    [
      await svc.balance(f.actor, target, { as_of: q.date_to }),
      await svc.balance(f.actor, f.ledger, { as_of: q.date_to }),
    ],
    [
      await svc.income(f.actor, target, { ...q, grain: 'month' }),
      await svc.income(f.actor, f.ledger, { ...q, grain: 'month' }),
    ],
    [
      await svc.category(f.actor, target, { ...q, kind: 'expense' }),
      await svc.category(f.actor, f.ledger, { ...q, kind: 'expense' }),
    ],
    [
      await svc.budget(f.actor, target, {
        year: '2026',
        grain: 'month',
        kind: 'expense',
      }),
      await svc.budget(f.actor, f.ledger, {
        year: '2026',
        grain: 'month',
        kind: 'expense',
      }),
    ],
  ])
    expect(normalize(a, ids)).toEqual(normalize(c, {}));
  const qs = queryService(f.db);
  const a = await qs.search(f.actor, target, {}),
    c = await qs.search(f.actor, f.ledger, {});
  expect(a.totals).toEqual(c.totals);
});
it('structure keeps budgets and disabled rules with reset schedule, no occurrences/worker; Life2023 round trip still works', async () => {
  const res = await post(original, 'structure', '合成P2結構');
  expect(res.statusCode, res.body).toBe(201);
  const r = res.json(),
    b = await backupService(f.db).download(f.actor, r.ledger.id);
  expect(b.ledger.locked_until).toBeNull();
  expect(b.tables.recurring_occurrences).toHaveLength(0);
  expect(b.tables.transactions).toHaveLength(0);
  expect(b.tables.budgets).toHaveLength(12);
  expect(b.tables.recurring_rules[0]).toMatchObject({
    active: false,
    next_on: '2026-01-31',
  });
  const csv =
    '記錄日期,來源項目,目的帳目,異動金額,摘要,收付人,專案代號,發票號碼\r\n2026/01/31,合成現金,合成餐費,1000.37,合成P2摘要,合成店,合成案,\r\n';
  await life2023Service(f.db).confirm(f.actor, r.ledger.id, {
    file_base64: Buffer.from(csv).toString('base64'),
  });
  const svc = reportService(f.db);
  expect(
    (
      await svc.income(f.actor, r.ledger.id, {
        date_from: '2026-01-01',
        date_to: '2026-12-31',
        grain: 'year',
      })
    ).periods,
  ).toEqual(
    (
      await svc.income(f.actor, f.ledger, {
        date_from: '2026-01-01',
        date_to: '2026-12-31',
        grain: 'year',
      })
    ).periods,
  );
});
it('genuine v1 shape and checksum restore empty P2 sections; v2 missing sections and unknown fields remain strict', async () => {
  const old = structuredClone(original) as unknown as Record<string, unknown>;
  old.schemaVersion = 1;
  old.format = 'life-ledger';
  old.tables = Object.fromEntries(
    legacyBackupTableNames.map((k) => [
      k,
      k === 'items'
        ? original.tables.items.map((row) =>
            Object.fromEntries(
              Object.entries(row).filter(([key]) => key !== 'securities'),
            ),
          )
        : original.tables[k],
    ]),
  );
  old.counts = Object.fromEntries(
    legacyBackupTableNames.map((k) => [k, original.counts[k]]),
  );
  old.payloadSha256 = backupPayloadSha256(old.tables);
  const r = await post(old, 'full', '合成舊版');
  expect(r.statusCode, r.body).toBe(201);
  const b = await backupService(f.db).download(f.actor, r.json().ledger.id);
  for (const k of [
    'recurring_rules',
    'recurring_occurrences',
    'budgets',
  ] as const)
    expect(b.tables[k]).toEqual([]);
  expect(
    (await post({ ...old, schemaVersion: 2 }, 'full', 'bad', 'preview')).json()
      .error,
  ).toBe('invalid_backup');
  expect(
    (
      await post({ ...original, unknown: true }, 'full', 'bad', 'preview')
    ).json().error,
  ).toBe('invalid_backup');
});
it('deleted rules/transactions retain posted and skipped history with one consistent new source UUID, no recreated rule', async () => {
  const s = recurringService(f.db);
  await f.db`UPDATE ledgers SET locked_until=NULL WHERE id=${f.ledger}`;
  const cash = original.tables.items.find((i) => i.kind === 'asset')!,
    food = original.tables.items.find((i) => i.kind === 'expense')!;
  const rule = await s.save(f.actor, f.ledger, {
    name: '合成刪除歷史',
    frequency: 'monthly',
    day_of_month: 1,
    start_on: '2026-01-01',
    end_on: '2026-03-01',
    template: {
      entries: [
        { item_id: cash.id, amount: '-7.00' },
        { item_id: food.id, amount: '7.00' },
      ],
    },
  });
  await s.generate(f.actor, f.ledger, new Date('2026-03-01T04:00:00Z'));
  const o = (await s.occurrences(f.actor, f.ledger)).filter(
    (o) => o.rule_id === rule.id,
  );
  expect(o).toHaveLength(3);
  const first = await s.post(f.actor, f.ledger, o[0]!.id),
    last = await s.post(f.actor, f.ledger, o[2]!.id);
  await s.skip(f.actor, f.ledger, o[1]!.id);
  await transactionService(f.db).remove(
    f.actor,
    f.ledger,
    last.transaction_id!,
  );
  await s.remove(f.actor, f.ledger, rule.id);
  const b = await backupService(f.db).download(f.actor, f.ledger),
    p = await post(b, 'full', '合成歷史預覽', 'preview');
  expect(p.statusCode, p.body).toBe(200);
  expect(p.json().recurring_history).toEqual({
    deleted_rule_occurrences: 3,
    posted_without_transaction: 1,
    deleted_rule_transactions: 1,
  });
  const r = await post(b, 'full', '合成歷史還原');
  expect(r.statusCode, r.body).toBe(201);
  const data = r.json(),
    restored = await backupService(f.db).download(f.actor, data.ledger.id),
    source = data.id_map.source_rules[rule.id];
  expect(source).not.toBe(rule.id);
  expect(restored.tables.recurring_rules.some((r) => r.id === source)).toBe(
    false,
  );
  const history = restored.tables.recurring_occurrences.filter(
    (o) => o.source_rule_id === source,
  );
  expect(history).toHaveLength(3);
  expect(history.every((o) => o.rule_id === null)).toBe(true);
  expect(
    history.filter((o) => o.status === 'posted' && o.transaction_id === null),
  ).toHaveLength(1);
  expect(history.filter((o) => o.status === 'skipped')).toHaveLength(1);
  const tx = restored.tables.transactions.find(
    (t) => t.id === data.id_map.transactions[first.transaction_id!],
  );
  expect(tx!.source_id).toBe(source + ':' + o[0]!.occurs_on);
});
it('malformed recurring source IDs/dates and missing non-null occurrence/template/budget references reject in preview', async () => {
  for (const value of [
    'bad',
    'not-uuid:2026-01-01',
    randomUUID() + ':2026-02-30',
    randomUUID() + ':0000-01-01',
  ]) {
    const b = structuredClone(original);
    b.tables.transactions[0]!.source_system = 'recurring';
    b.tables.transactions[0]!.source_id = value;
    refresh(b);
    expect((await post(b, 'full', 'bad', 'preview')).json().error).toBe(
      'reference_invalid',
    );
  }
  for (const change of [
    (b: LedgerBackup) => {
      b.tables.recurring_occurrences[0]!.rule_id = randomUUID();
    },
    (b: LedgerBackup) => {
      b.tables.recurring_occurrences[0]!.transaction_id = randomUUID();
    },
    (b: LedgerBackup) => {
      b.tables.recurring_occurrences[0]!.source_rule_id = 'bad';
    },
    (b: LedgerBackup) => {
      b.tables.recurring_rules[0]!.template.entries[0]!.item_id = randomUUID();
    },
    (b: LedgerBackup) => {
      b.tables.budgets[0]!.item_id = randomUUID();
    },
  ]) {
    const b = structuredClone(original);
    change(b);
    refresh(b);
    expect((await post(b, 'full', 'bad', 'preview')).json().error).toBe(
      'reference_invalid',
    );
  }
});
it('P2 checksum tampering rejects; rehashed constraint failure rolls back ledger and every P2 row without disabling constraints', async () => {
  const b = structuredClone(original);
  b.tables.budgets[0]!.amount = '11.01';
  expect((await post(b, 'full', 'bad', 'preview')).json().error).toBe(
    'backup_checksum_mismatch',
  );
  refresh(b);
  b.tables.budgets[0]!.item_id = b.tables.items.find(
    (i) => i.kind === 'asset',
  )!.id;
  refresh(b);
  const [before] = await f.db`SELECT count(*)::int n FROM ledgers`;
  const res = await post(b, 'full', '合成必須回滾');
  expect(res.statusCode).toBe(400);
  const [after] = await f.db`SELECT count(*)::int n FROM ledgers`;
  expect(after!.n).toBe(before!.n);
  const [none] =
    await f.db`SELECT count(*)::int n FROM ledgers WHERE name='合成必須回滾'`;
  expect(none!.n).toBe(0);
});
