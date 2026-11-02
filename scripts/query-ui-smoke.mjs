// SPDX-License-Identifier: AGPL-3.0-only
import { revealItemOption } from './item-picker-test.mjs';
// Synthetic HTTP → browser → DB acceptance; never point at a real ledger DB.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  transactionService,
  sessionService,
  ledgerService,
  itemService,
  namedRecordService,
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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/query';
await mkdir(output, { recursive: true });
const issuer = `https://query-ui-${Date.now()}.synthetic.invalid`;
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
    }),
    items = itemService(db);
  const cash = await items.create(actor, ledger.id, {
      name: '合成現金',
      kind: 'asset',
      currency: 'TWD',
    }),
    expense = await items.create(actor, ledger.id, {
      name: '合成費用',
      kind: 'expense',
      currency: 'TWD',
    }),
    usd = await items.create(actor, ledger.id, {
      name: '合成美元資產',
      kind: 'asset',
      currency: 'USD',
    }),
    usdExpense = await items.create(actor, ledger.id, {
      name: '合成美元費用',
      kind: 'expense',
      currency: 'USD',
    });
  const payee = await namedRecordService(db, 'payees').create(
      actor,
      ledger.id,
      { name: '合成收付人' },
    ),
    project = await namedRecordService(db, 'projects').create(
      actor,
      ledger.id,
      { name: '合成專案' },
    );
  await namedRecordService(db, 'memo_templates').create(actor, ledger.id, {
    name: '合成常用摘要',
    memo: '合成範本內容',
  });
  await db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES (${ledger.id},'2026-10-17','USD','TWD','32.567')`;
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
  const parent = await items.create(actor, ledger.id, {
    name: '合成支出總類',
    kind: 'expense',
    currency: 'TWD',
  });
  await items.update(actor, ledger.id, expense.id, {
    parent_id: parent.id,
  });
  const travel = await items.create(actor, ledger.id, {
    name: '合成交通',
    kind: 'expense',
    currency: 'TWD',
  });
  const salary = await items.create(actor, ledger.id, {
    name: '合成薪資',
    kind: 'income',
    currency: 'TWD',
  });
  const tx = transactionService(db);
  for (const input of [
    {
      occurred_on: '2026-10-01',
      memo: '合成 T1',
      invoice_no: 'INV-AbC',
      payee_id: payee.id,
      project_id: project.id,
      entries: [
        { item_id: cash.id, amount: '-120' },
        { item_id: expense.id, amount: '120' },
      ],
    },
    {
      occurred_on: '2026-10-05',
      memo: '合成 T2',
      entries: [
        { item_id: salary.id, amount: '-35000' },
        { item_id: cash.id, amount: '35000' },
      ],
    },
    {
      occurred_on: '2026-10-09',
      memo: '=合成 T3 ABC',
      payee_id: payee.id,
      project_id: project.id,
      entries: [
        { item_id: cash.id, amount: '-1000' },
        { item_id: expense.id, amount: '600' },
        { item_id: travel.id, amount: '400' },
      ],
    },
  ])
    await tx.create(actor, ledger.id, input);
  await page.goto('https://localhost:18444/transactions');
  await page.goto('https://localhost:18444/transactions');
  await page.getByText(/^共 3 筆/).waitFor();
  await page.getByRole('button', { name: '展開多筆分錄', exact: true }).click();
  await page
    .getByTestId('query-transaction')
    .filter({ visible: true })
    .getByText('合成交通', { exact: true })
    .waitFor();
  const field = (name) => page.getByRole('textbox', { name, exact: true });
  async function select(label, name) {
    await field(label).click();
    await revealItemOption(page, name);
    await page.getByRole('option', { name, exact: true }).click();
  }
  const openTools = () =>
    page.getByRole('button', { name: /^篩選與工具/ }).click();
  const closeTools = () =>
    page.getByRole('button', { name: '關閉篩選與工具', exact: true }).click();
  await openTools();
  await field('起始日期').fill('2026-10-01');
  await field('結束日期').fill('2026-10-09');
  await field('最小交易金額（本位幣）').fill('100');
  await field('最大交易金額（本位幣）').fill('1000');
  await select('篩選專案', '合成專案');
  await select('篩選收付人', '合成收付人');
  await select('交易類別', '支出');
  await field('篩選科目（含子科目）').click();
  await page
    .getByRole('option', { name: '合成支出總類 ›', exact: true })
    .click();
  await page
    .getByRole('option', { name: '全部 合成支出總類（含子科目）', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await field('關鍵字').fill('abc');
  await field('關鍵字').press('Enter');
  await page.getByText(/^共 2 筆/).waitFor();
  await openTools();
  await select('每次載入筆數', '1');
  await closeTools();
  await page.getByText('已載入 1／2 筆', { exact: true }).waitFor();
  await page.getByText('=合成 T3 ABC', { exact: true }).waitFor();
  await page.getByRole('button', { name: '載入更多', exact: true }).click();
  await page.getByText('合成 T1', { exact: true }).waitFor();
  await page.getByText('已載入 2／2 筆', { exact: true }).waitFor();
  assert.equal(
    await page
      .getByTestId('query-transaction')
      .filter({ visible: true })
      .count(),
    2,
  );
  await page.getByText('=合成 T3 ABC', { exact: true }).waitFor();
  await page.screenshot({
    path: output + '/query-filter-390.png',
    fullPage: true,
  });
  await openTools();
  await page.getByText('彙總', { exact: true }).click();
  await closeTools();
  await page
    .getByLabel('主內容', { exact: true })
    .getByText('合成費用', { exact: true })
    .waitFor();
  await openTools();
  await select('彙總方式', '依月份與類別');
  await closeTools();
  await page.getByText('2026-10', { exact: true }).first().waitFor();
  await page.screenshot({
    path: output + '/query-summary-390.png',
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    ),
    false,
  );
  await openTools();
  for (const format of ['明細', '分錄']) {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: '匯出 CSV', exact: true }).click();
    await page
      .getByRole('menuitem', { name: `匯出${format} CSV`, exact: true })
      .click();
    const download = await pending;
    const file = output + `/query-${format}.csv`;
    await download.saveAs(file);
    const content = await readFile(file);
    assert.deepEqual([...content.subarray(0, 3)], [239, 187, 191]);
    const rows = parse(content, { bom: true, cast: false });
    assert.equal(rows.length, format === '明細' ? 3 : 6);
    if (format === '明細') {
      assert.equal(rows[1][2], "'=合成 T3 ABC");
      assert.equal(rows[1][6], '1000.00');
      assert.equal(rows[1][7], '600.00');
    }
  }
  await field('最小交易金額（本位幣）').fill('999');
  assert.equal(
    await page
      .getByRole('button', { name: '匯出 CSV', exact: true })
      .isDisabled(),
    true,
  );
  console.log(
    '390px CSV downloads: detail2 / entries5 / applied filters / UTF8 BOM / formula guard PASS',
  );
  assert.ok(usd.id && usdExpense.id);
  assert.deepEqual(errors, []);
  console.log(
    '390px query: AND filters / descendant account / cursor append/no duplicates / multiple entries / summaries / no overflow PASS',
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
