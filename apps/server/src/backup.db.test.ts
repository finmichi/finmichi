// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, it, expect } from 'vitest';
import { fixture } from '../test/catalog-fixture.js';
import {
  itemService,
  transactionService,
  namedRecordService,
  backupService,
  backupPayloadSha256,
  life2023Service,
} from '@finmichi/core';
import type { LedgerBackup } from '@finmichi/core/backup-schemas';
import { backupTableNames } from '@finmichi/core/backup-schemas';
let f: Awaited<ReturnType<typeof fixture>>;
const url = () => `/api/ledgers/${f.ledger}/backup.json`;
beforeAll(async () => {
  f = await fixture('json-backup');
  const items = itemService(f.db);
  const parent = await items.create(f.actor, f.ledger, {
      name: '合成資產',
      kind: 'asset',
      currency: 'TWD',
    }),
    cash = await items.create(f.actor, f.ledger, {
      name: '合成現金',
      kind: 'asset',
      currency: 'TWD',
      parent_id: parent.id,
    }),
    usd = await items.create(f.actor, f.ledger, {
      name: '合成美元',
      kind: 'asset',
      currency: 'USD',
      parent_id: parent.id,
    }),
    food = await items.create(f.actor, f.ledger, {
      name: '合成餐費',
      kind: 'expense',
      currency: 'TWD',
      fixed: true,
    });
  const payee = await namedRecordService(f.db, 'payees').create(
      f.actor,
      f.ledger,
      { name: '合成商店' },
    ),
    project = await namedRecordService(f.db, 'projects').create(
      f.actor,
      f.ledger,
      { name: '合成計畫' },
    );
  await namedRecordService(f.db, 'memo_templates').create(f.actor, f.ledger, {
    name: '合成摘要模板',
    memo: '合成文字',
  });
  await transactionService(f.db).create(f.actor, f.ledger, {
    occurred_on: '2026-10-17',
    memo: '合成外幣',
    payee_id: payee.id,
    project_id: project.id,
    entries: [
      { item_id: usd.id, amount: '-0.123456', exchange_rate: '32.5123456789' },
      { item_id: cash.id, amount: '4.01' },
    ],
  });
  await f.db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES (${f.ledger},'2026-10-17','USD','TWD',32.5123456789)`;
  const csv =
    '記錄日期,來源項目,目的帳目,異動金額,摘要,收付人,專案代號,發票號碼\r\n2026/10/17,合成現金,合成餐費,10.00,合成來源追蹤,,,\r\n';
  await life2023Service(f.db).confirm(f.actor, f.ledger, {
    file_base64: Buffer.from(csv).toString('base64'),
  });
  await items.update(f.actor, f.ledger, food.id, { archived: true });
  await f.db`UPDATE ledgers SET locked_until='2026-10-17' WHERE id=${f.ledger}`;
});
afterAll(async () => {
  if (f) await f.close();
});
it('backup includes every allowlisted table, exact numeric strings/order/flags/lock and canonical checksum, no auth data', async () => {
  const response = await f.app.inject({ url: url(), headers: f.headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-disposition']).toContain(
    "filename*=UTF-8''finmichi-",
  );
  const backup = response.json<LedgerBackup>();
  expect(backup.format).toBe('finmichi');
  expect(backup.schemaVersion).toBe(9);
  expect(backup.appVersion).toBe('test');
  expect(backup.ledger.locked_until).toBe('2026-10-17');
  expect(Object.keys(backup.tables).sort()).toEqual(
    [...backupTableNames].sort(),
  );
  expect(backup.payloadSha256).toBe(backupPayloadSha256(backup.tables));
  for (const table of backupTableNames) {
    expect(backup.counts[table]).toBe(backup.tables[table].length);
    const [count] =
      await f.db`SELECT count(*)::integer AS n FROM ${f.db(table)} WHERE ledger_id=${f.ledger}`;
    expect(backup.counts[table]).toBe(count!.n);
  }
  expect(backup.tables.items.some((i) => i.archived && i.fixed)).toBe(true);
  expect(backup.tables.exchange_rates[0]!.rate).toBe('32.5123456789');
  const entries =
    await f.db`SELECT id,amount::text,exchange_rate::text,base_amount::text,entry_position FROM transaction_entries WHERE ledger_id=${f.ledger} ORDER BY transaction_id,entry_position`;
  expect(
    backup.tables.transaction_entries.map((e) => ({
      id: e.id,
      amount: e.amount,
      exchange_rate: e.exchange_rate,
      base_amount: e.base_amount,
      entry_position: e.entry_position,
    })),
  ).toEqual(entries.map((e) => ({ ...e })));
  for (const entry of backup.tables.transaction_entries)
    expect(
      [entry.amount, entry.base_amount, entry.exchange_rate].every(
        (v) => typeof v === 'string',
      ),
    ).toBe(true);
  for (const forbidden of [
    'owner_id',
    'users',
    'sessions',
    'audit_logs',
    'token_hash',
    'oidc_subject',
    'oidc_issuer',
  ])
    expect(response.body).not.toContain('"' + forbidden + '"');
});
it('backup enforces owner 404 and anonymous 401, audits attempts without changing ledger data', async () => {
  const before = (await f.db`SELECT count(*)::integer AS n FROM audit_logs`)[0]!
    .n;
  expect(
    (await f.app.inject({ url: url(), headers: f.otherHeaders })).statusCode,
  ).toBe(404);
  expect((await f.app.inject({ url: url() })).statusCode).toBe(401);
  const response = await backupService(f.db).download(f.actor, f.ledger);
  expect(response.counts.transactions).toBe(2);
  expect(
    (await f.db`SELECT count(*)::integer AS n FROM audit_logs`)[0]!.n,
  ).toBe(before + 2);
});
