// SPDX-License-Identifier: AGPL-3.0-only
import { parse } from 'csv-parse/sync';
// Synthetic HTTP → browser → DB acceptance; never point at a real ledger DB.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  transactionService,
  ledgerService,
  itemService,
} from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const address = new URL(databaseUrl);
if (
  !['127.0.0.1', 'localhost'].includes(address.hostname) ||
  !['/life_test', '/synthetic'].includes(address.pathname)
)
  throw new Error('Only a local synthetic test database is allowed');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/life2023';
await mkdir(output, { recursive: true });
const issuer = `https://life2023-ui-${Date.now()}.synthetic.invalid`;
const discovery = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      issuer,
      authorization_endpoint: issuer + '/authorize',
      token_endpoint: issuer + '/token',
      jwks_uri: issuer + '/jwks',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    }),
  );
});
let db, app, browser;
try {
  discovery.listen(0, '127.0.0.1');
  await once(discovery, 'listening');
  db = connect(databaseUrl);
  await migrate(db);
  const sessions = sessionService(db, ['synthetic-owner']),
    token = await sessions.login(issuer, 'synthetic-owner'),
    actor = (await sessions.authenticate(token)).id;
  const ledger = await ledgerService(db).create(actor, {
    name: '合成交易測試帳本',
  });
  for (const [name, kind] of [
    ['合成現金', 'asset'],
    ['合成支出', 'expense'],
    ['合成支出', 'income'],
  ])
    await itemService(db).create(actor, ledger.id, {
      name,
      kind,
      currency: 'TWD',
    });
  app = await createApp(
    {
      databaseUrl,
      publicUrl: 'https://localhost:18444',
      issuer,
      clientId: 'synthetic',
      allowedSubjects: ['synthetic-owner'],
      trustProxy: 0,
      version: 'ui-test',
      mockInternalUrl: `http://127.0.0.1:${discovery.address().port}`,
      tlsKey: 'deploy/local/tls-key',
      tlsCert: 'deploy/local/tls-cert',
    },
    db,
  );
  await app.listen({ host: '127.0.0.1', port: 18444 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {}),
    // Isolated synthetic localhost browser; generated dev certificate only.
    args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies([
    {
      name: 'session',
      value: token,
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('https://localhost:18444/admin/import');

  await page.getByText(/重新匯入時會保留/).waitFor();
  const upload = async (name) => {
    await page
      .locator('input[type=file]')
      .setInputFiles('fixtures/life2023/' + name);
    await page
      .getByRole('button', { name: '上傳並預覽 CSV', exact: true })
      .click();
    await page.getByTestId('import-row').first().waitFor();
  };
  await upload('life2023-utf8.csv');
  await page
    .getByRole('textbox', { name: '目的帳目：合成支出', exact: true })
    .click();
  await page
    .getByRole('option', { name: '合成支出（支出／TWD）', exact: true })
    .click();
  const checkedPreview = page.waitForResponse(
    (r) =>
      r.url().includes('/imports/life2023/preview') &&
      r.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: '重新檢查對應與預覽', exact: true })
    .click();
  assert.equal((await (await checkedPreview).json()).total_amount, '1234.50');
  await page.getByText('金額合計：NT$ 1,234.50', { exact: true }).waitFor();
  assert.ok(
    (await page.getByTestId('import-row').first().innerText()).includes(
      'NT$ 1,234.50',
    ),
    'valid preview row uses the same money format; invalid source cells remain readable',
  );
  await page.screenshot({
    path: output + '/preview-mapping-390.png',
    fullPage: true,
  });
  async function confirm() {
    await page
      .getByRole('checkbox', {
        name: '我已核對預覽與疑似重複列，確認寫入此帳本',
        exact: true,
      })
      .check();
    await page
      .getByRole('button', { name: '確認寫入 CSV', exact: true })
      .click();
    await page.getByRole('dialog', { name: '確認匯入', exact: true }).waitFor();
    await page
      .getByRole('button', { name: '確認整批寫入', exact: true })
      .click();
    await page
      .getByRole('status')
      .filter({ hasText: '已匯入 1 筆，略過 0 筆。' })
      .waitFor();
  }
  await confirm();
  await page.screenshot({ path: output + '/imported-390.png', fullPage: true });
  await upload('life2023-big5.csv');
  await page
    .getByRole('textbox', { name: '目的帳目：合成支出', exact: true })
    .click();
  await page
    .getByRole('option', { name: '合成支出（支出／TWD）', exact: true })
    .click();
  await page
    .getByRole('button', { name: '重新檢查對應與預覽', exact: true })
    .click();
  await page
    .getByText(/偵測編碼：big5；可匯入 1 筆；錯誤 0 筆；疑似重複 1 筆/)
    .waitFor();
  await page.screenshot({
    path: output + '/big5-duplicate-390.png',
    fullPage: true,
  });
  await confirm();
  const [cash] =
    await db`SELECT id FROM items WHERE ledger_id=${ledger.id} AND name='合成現金' AND kind='asset'`;
  const [cost] =
    await db`SELECT id FROM items WHERE ledger_id=${ledger.id} AND name='合成支出' AND kind='expense'`;
  const foreign = await itemService(db).create(actor, ledger.id, {
    name: '合成美元',
    kind: 'asset',
    currency: 'USD',
  });
  await transactionService(db).create(actor, ledger.id, {
    occurred_on: '2026-10-18',
    memo: '合成多分錄',
    entries: [
      { item_id: cash.id, amount: '-10' },
      { item_id: cost.id, amount: '4' },
      { item_id: cost.id, amount: '6' },
    ],
  });
  await transactionService(db).create(actor, ledger.id, {
    occurred_on: '2026-10-19',
    memo: '合成外幣',
    entries: [
      { item_id: foreign.id, amount: '-1', exchange_rate: '32.5' },
      { item_id: cash.id, amount: '32.5' },
    ],
  });
  await page.goto('https://localhost:18444/transactions');
  await page.getByRole('button', { name: /^篩選與工具/ }).click();
  await page.getByRole('button', { name: '匯出 CSV', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '匯出 Life2023 CSV', exact: true })
    .waitFor();
  const pending = page.waitForEvent('download');
  await page
    .getByRole('menuitem', { name: '匯出 Life2023 CSV', exact: true })
    .click();
  const download = await pending;
  await download.saveAs(output + '/life2023.csv');
  const bytes = await readFile(output + '/life2023.csv');
  assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
  const records = parse(bytes, { bom: true, cast: false });
  assert.equal(records.length, 3);
  assert.equal(records[1][3], '1234.50');
  assert.equal(records[1][4], '"合成",逗號\n換行');
  await page
    .getByRole('button', { name: '關閉篩選與工具', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: '已匯出 2 筆；未匯出 2 筆。' })
    .waitFor();
  await page.getByText('多筆分錄：1 筆', { exact: true }).waitFor();
  await page.getByText('含外幣科目：1 筆', { exact: true }).waitFor();
  await page
    .getByText('請改用「匯出分錄 CSV」保留完整分錄。', { exact: true })
    .waitFor();
  await page.screenshot({ path: output + '/export-390.png', fullPage: true });
  await page
    .getByRole('textbox', { name: '關鍵字', exact: true })
    .fill('不存在');
  await page
    .getByRole('textbox', { name: '關鍵字', exact: true })
    .press('Enter');
  await page.getByRole('status').filter({ hasText: '共 0 筆' }).waitFor();
  await page.getByRole('button', { name: /^篩選與工具/ }).click();
  const emptyPending = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出 CSV', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '匯出 Life2023 CSV', exact: true })
    .click();
  const emptyDownload = await emptyPending;
  await emptyDownload.saveAs(output + '/empty.csv');
  assert.equal(
    parse(await readFile(output + '/empty.csv'), { bom: true }).length,
    1,
  );
  console.log(
    '390px Life2023 export: UTF8 BOM / eight columns / numeric amount / multiline memo / active query filters PASS',
  );
  const tx =
    await db`SELECT id,memo FROM transactions WHERE ledger_id=${ledger.id} AND source_system='life2023-csv'`;
  assert.equal(tx.length, 2);
  assert.equal(tx[0].memo, '"合成",逗號\n換行');
  assert.equal(
    (
      await db`SELECT count(*)::integer AS n FROM import_jobs WHERE ledger_id=${ledger.id} AND status='imported'`
    )[0].n,
    2,
  );
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    '390px Life2023 import: UTF8 / Big5 / same-name-kind mapping / preview / confirm / suspected duplicate / no overflow PASS',
  );
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (discovery.listening) {
    discovery.close();
    await once(discovery, 'close');
  }
  if (db) await db.end();
}
