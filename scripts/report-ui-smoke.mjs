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
} from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
import { seedReport } from './report-fixture.mjs';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const address = new URL(databaseUrl);
if (
  !['127.0.0.1', 'localhost'].includes(address.hostname) ||
  !['/life_test', '/synthetic'].includes(address.pathname)
)
  throw new Error('Only a local synthetic test database is allowed');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/reports';
await mkdir(output, { recursive: true });
const issuer = `https://report-ui-${Date.now()}.synthetic.invalid`;
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
  const fixture = await seedReport(db, actor, ledger.id);
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
  await page.goto('https://localhost:18444/reports/balance-sheet');

  const field = (name) => page.getByRole('textbox', { name, exact: true });
  await field('基準日').fill('2026-10-31');
  await page
    .getByRole('button', { name: '產生資產負債表', exact: true })
    .click();
  await page
    .locator('.report-kpi')
    .filter({ hasText: '資產合計' })
    .getByText('NT$ 43,930', { exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: '收合流動資產', exact: true })
    .waitFor();
  await page
    .locator('.report-amount-main')
    .filter({ hasText: 'NT$ 43,880' })
    .waitFor();
  await page.getByText(/恆等式驗算通過/).waitFor();
  await page.screenshot({ path: output + '/balance-390.png', fullPage: true });
  async function download(label, file) {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: label, exact: true }).click();
    const download = await pending;
    await download.saveAs(output + '/' + file);
    const bytes = await readFile(output + '/' + file);
    assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
    return parse(bytes, { bom: true, cast: false });
  }
  const rows = await download('匯出資產負債表 CSV', 'balance.csv');
  assert.ok(rows.some((r) => r[3] === '淨值' && r[5] === '43930.00'));
  await field('基準日').fill('2026-11-30');
  await page
    .getByRole('button', { name: '產生資產負債表', exact: true })
    .click();
  await page.getByText(/基準日：2026-11-30/).waitFor();
  await page
    .getByRole('button', { name: '收合流動資產', exact: true })
    .waitFor();
  await page
    .locator('.report-amount-main')
    .filter({ hasText: 'NT$ 41,880' })
    .waitFor();
  const usd = await itemService(db).create(actor, ledger.id, {
    name: '合成美元',
    kind: 'asset',
    currency: 'USD',
    parent_id: fixture.assets,
  });
  await transactionService(db).create(actor, ledger.id, {
    occurred_on: '2026-12-01',
    entries: [
      { item_id: fixture.cash, amount: '-3250' },
      { item_id: usd.id, amount: '100', exchange_rate: '32.5' },
    ],
  });
  await field('基準日').fill('2026-12-31');
  await page
    .getByRole('button', { name: '產生資產負債表', exact: true })
    .click();
  await page.getByText(/基準日：2026-12-31/).waitFor();
  await page
    .getByRole('button', { name: '收合流動資產', exact: true })
    .waitFor();
  await page.getByText('USD 100.00', { exact: true }).waitFor();
  await page
    .locator('.report-amount-main')
    .filter({ hasText: 'NT$ 3,250' })
    .waitFor();
  await page.screenshot({
    path: output + '/balance-foreign-390.png',
    fullPage: true,
  });
  await page
    .getByRole('navigation', { name: '報表分頁' })
    .getByRole('link', { name: '收支彙總', exact: true })
    .click();
  await field('收支起始日期').fill('2026-10-01');
  await field('收支結束日期').fill('2026-11-30');
  await page.getByRole('button', { name: '產生收支彙總', exact: true }).click();
  await page
    .getByTestId('income-totals')
    .locator('dl > div')
    .filter({ hasText: '淨收支' })
    .getByText('NT$ 33,930', { exact: true })
    .waitFor();
  const november = page.getByTestId('income-period').filter({
    has: page.getByRole('heading', { name: '2026-11', exact: true }),
  });
  await november
    .locator('dl > div')
    .filter({ hasText: '收入合計' })
    .getByText('NT$ 0', { exact: true })
    .waitFor();
  await november
    .locator('dl > div')
    .filter({ hasText: '支出合計' })
    .getByText('NT$ 0', { exact: true })
    .waitFor();
  const incomeRows = await download('匯出收支彙總 CSV', 'income.csv');
  assert.ok(
    incomeRows.some((r) => r[4] === '期間合計' && r[13] === '33930.00'),
  );
  await page.getByRole('textbox', { name: '收支粒度', exact: true }).click();
  await page.getByRole('option', { name: '季', exact: true }).click();
  await page.getByRole('button', { name: '產生收支彙總', exact: true }).click();
  await page.getByRole('heading', { name: '2026-Q4', exact: true }).waitFor();
  await page.screenshot({ path: output + '/income-390.png', fullPage: true });
  console.log(
    '390px income: operating/non-operating / zero transfer month / quarterly period / CSV download PASS',
  );
  await page.getByText('計算說明', { exact: true }).click();
  await page
    .getByRole('note')
    .filter({ hasText: '季：最多 1,000 季' })
    .waitFor();
  await page.getByRole('textbox', { name: '收支粒度', exact: true }).click();
  await page.getByRole('option', { name: '日', exact: true }).click();
  await page
    .getByRole('note')
    .filter({ hasText: '日：最多 1,000 天' })
    .waitFor();
  await field('收支起始日期').fill('1900-01-01');
  await field('收支結束日期').fill('2100-12-31');
  await page.getByRole('button', { name: '產生收支彙總', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: '一次最多查詢 1,000 個時段' })
    .waitFor();
  await page.screenshot({
    path: output + '/income-limit-390.png',
    fullPage: true,
  });
  console.log('390px period limit: grain hint / 1001+ Chinese error PASS');
  async function select(label, name) {
    await page.getByRole('textbox', { name: label, exact: true }).click();
    await revealItemOption(page, name);
    await page.getByRole('option', { name, exact: true }).click();
  }
  await page
    .getByRole('navigation', { name: '報表分頁' })
    .getByRole('link', { name: '分類統計', exact: true })
    .click();
  await field('分類起始日期').fill('2026-10-01');
  await field('分類結束日期').fill('2026-10-31');
  await page.getByRole('button', { name: '產生分類統計', exact: true }).click();
  await page.getByText(/期間：2026-10-01～2026-10-31/).waitFor();
  await page.getByText('期間總額：NT$ 1,120.00', { exact: true }).waitFor();
  await page.getByRole('button', { name: '展開生活支出', exact: true }).click();
  await page.getByText('64.29%', { exact: true }).waitFor();
  await page.getByText('35.71%', { exact: true }).waitFor();
  await page
    .getByRole('img', { name: '分類圓餅圖', exact: true })
    .locator('canvas')
    .waitFor();
  await page
    .getByRole('img', { name: '分類前十名長條圖', exact: true })
    .locator('canvas')
    .waitFor();
  const categoryRows = await download('匯出分類統計 CSV', 'category.csv');
  assert.ok(
    categoryRows.some(
      (r) => r[6] === '餐費' && r[9] === '720.00' && r[10] === '64.2857142857',
    ),
  );
  await page.screenshot({
    path: output + '/category-positive-390.png',
    fullPage: true,
  });
  await select('固定性篩選', '僅固定');
  await page.getByRole('button', { name: '產生分類統計', exact: true }).click();
  await page.getByText('期間總額：NT$ 720.00', { exact: true }).waitFor();
  await select('業外篩選', '僅業外');
  await page.getByRole('button', { name: '產生分類統計', exact: true }).click();
  await page.getByText('不適用（總額為 0）', { exact: true }).first().waitFor();
  assert.equal(
    await page.getByRole('img', { name: '分類圓餅圖', exact: true }).count(),
    0,
  );
  await select('固定性篩選', '全部');
  await select('業外篩選', '全部');
  async function refund(amount, total, message, file) {
    await transactionService(db).create(actor, ledger.id, {
      occurred_on: '2026-10-15',
      entries: [
        { item_id: fixture.food, amount: '-' + amount },
        { item_id: fixture.cash, amount },
      ],
    });
    await page
      .getByRole('button', { name: '產生分類統計', exact: true })
      .click();
    await page
      .getByText(
        `期間總額：${total.startsWith('-') ? '−' : ''}NT$ ${total.replace('-', '')}`,
        { exact: true },
      )
      .waitFor();
    await page.getByText(message, { exact: true }).first().waitFor();
    assert.equal(
      await page.getByRole('img', { name: '分類圓餅圖', exact: true }).count(),
      0,
    );
    await page
      .getByRole('img', { name: '分類前十名長條圖', exact: true })
      .locator('canvas')
      .waitFor();
    if (
      await page
        .getByRole('button', { name: '展開生活支出', exact: true })
        .count()
    )
      await page
        .getByRole('button', { name: '展開生活支出', exact: true })
        .click();
    await page.screenshot({ path: output + '/' + file, fullPage: true });
  }
  await refund(
    '800',
    '320.00',
    '含負值，請參考長條圖與明細',
    'category-negative-item-390.png',
  );
  await page.getByText('−25.00%', { exact: true }).waitFor();
  await refund('320', '0.00', '不適用（總額為 0）', 'category-zero-390.png');
  await refund(
    '1',
    '-1.00',
    '不適用（總額為負）',
    'category-negative-total-390.png',
  );
  const negativeRows = await download(
    '匯出分類統計 CSV',
    'category-negative.csv',
  );
  assert.ok(
    negativeRows.some(
      (r) => r[6] === '餐費' && r[9] === '-401.00' && r[10] === '',
    ),
  );
  console.log(
    '390px categories: tree / 2-digit percentage / ECharts pie+bar / own flags / CSV / positive-negative-zero boundaries / same-filter refresh PASS',
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
    '390px balance sheet: ADR totals / identity / tree expansion / as_of / foreign book and original / CSV download / no overflow PASS',
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
