// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic localhost only; no real financial data or tokens are written to evidence.
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  ledgerService,
  itemService,
  transactionService,
  marketService,
  securityService,
  reportService,
} from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const u = new URL(databaseUrl);
if (
  !['127.0.0.1', 'localhost'].includes(u.hostname) ||
  !['/life_test', '/synthetic'].includes(u.pathname)
)
  throw new Error('Synthetic local DB required');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-market';
await mkdir(output, { recursive: true });
const issuer = `https://market-ui-${Date.now()}.synthetic.invalid`,
  origin = 'https://localhost:18449';
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
    cookie = await sessions.login(issuer, 'synthetic-owner'),
    actor = (await sessions.authenticate(cookie)).id;

  const ledger = await ledgerService(db).create(actor, {
      name: '合成市場驗收帳本',
    }),
    items = itemService(db),
    tx = transactionService(db);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const old = new Date(day + 'T00:00:00Z');
  old.setUTCDate(old.getUTCDate() - 14);
  const oldDay = old.toISOString().slice(0, 10);
  const root = await items.create(actor, ledger.id, {
      name: '合成資產',
      kind: 'asset',
      currency: 'TWD',
    }),
    usd = await items.create(actor, ledger.id, {
      name: '合成美元',
      kind: 'asset',
      currency: 'USD',
      parent_id: root.id,
    }),
    cash = await items.create(actor, ledger.id, {
      name: '合成銀行',
      kind: 'asset',
      currency: 'TWD',
      parent_id: root.id,
    }),
    eur = await items.create(actor, ledger.id, {
      name: '合成歐元無行情',
      kind: 'asset',
      currency: 'EUR',
    }),
    liab = await items.create(actor, ledger.id, {
      name: '合成美元負債',
      kind: 'liability',
      currency: 'USD',
    }),
    eq = await items.create(actor, ledger.id, {
      name: '合成期初',
      kind: 'equity',
      currency: 'TWD',
    });
  for (const entries of [
    [
      { item_id: usd.id, amount: '100', exchange_rate: '30' },
      { item_id: eq.id, amount: '-3000' },
    ],
    [
      { item_id: cash.id, amount: '1500' },
      { item_id: liab.id, amount: '-50', exchange_rate: '30' },
    ],
    [
      { item_id: eur.id, amount: '10', exchange_rate: '35' },
      { item_id: eq.id, amount: '-350' },
    ],
  ])
    await tx.create(actor, ledger.id, { occurred_on: oldDay, entries });
  const cross = await ledgerService(db).create(actor, {
      name: '合成美元本位帳本',
      base_currency: 'USD',
    }),
    cEuro = await items.create(actor, cross.id, {
      name: '合成交叉歐元',
      kind: 'asset',
      currency: 'EUR',
    }),
    cEq = await items.create(actor, cross.id, {
      name: '合成美元權益',
      kind: 'equity',
      currency: 'USD',
    });
  await tx.create(actor, cross.id, {
    occurred_on: oldDay,
    entries: [
      { item_id: cEuro.id, amount: '100', exchange_rate: '1.1' },
      { item_id: cEq.id, amount: '-110' },
    ],
  });
  const csv = await readFile(
      'packages/core/test/fixtures/market/bot-trailing-empty.csv',
      'utf8',
    ),
    filename = 'ExchangeRate@' + day.replaceAll('-', '') + '1600.csv',
    market = marketService(db);
  await db`DELETE FROM market_fx_rates`;
  await db`DELETE FROM market_fetch_runs`;
  await db`DELETE FROM market_prices`;
  await db`DELETE FROM market_calendar`;
  await market.upload(actor, ledger.id, { filename, content: csv });
  const stockItem = await items.create(actor, ledger.id, {
    name: '合成報價科目',
    kind: 'asset',
    currency: 'TWD',
    securities: true,
  });
  await securityService(db).create(actor, ledger.id, {
    symbol: '9999Z',
    name: '合成報價證券',
    kind: 'stock',
    market: 'TPEx',
    item_id: stockItem.id,
  });
  await db`INSERT INTO market_fetch_runs(source,status,data_date,received_date,error_code,row_count,skipped_no_price) VALUES ('tpex','warning',${day},${day},'many_missing_prices',100,99)`;
  await db`INSERT INTO market_prices(trade_date,market,symbol,close,source) VALUES (${day},'TPEx','9999Z',10,'tpex')`;

  app = await createApp(
    {
      databaseUrl,
      publicUrl: origin,
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
  await app.listen({ host: '127.0.0.1', port: 18449 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {}),
    args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies([
    {
      name: 'session',
      value: cookie,
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await context.addInitScript(
    ({ id }) => {
      if (!globalThis.localStorage.getItem('finmichi-ledger'))
        globalThis.localStorage.setItem('finmichi-ledger', id);
    },
    { id: ledger.id },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const states = [],
    errors = [],
    external = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!['localhost', '127.0.0.1'].includes(new URL(r.url()).hostname))
      external.push(r.url());
  });
  const endpoint = `**/api/ledgers/${ledger.id}/market`;
  const settle = async () => {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => globalThis.document.fonts.ready);
  };
  async function capture(name, w, h, theme) {
    if (['balance', 'cross', 'stale'].includes(name))
      await page
        .locator('.market-kpis')
        .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    if (name === 'rates')
      await page
        .locator('.market-rate-table')
        .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    if (name === 'preview')
      await page
        .getByRole('region', { name: '匯率上傳預覽' })
        .evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => globalThis.document.fonts.ready);
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    );
    assert.equal(overflow, false, name);
    if (w < 900 && name === 'preview') {
      for (const el of [
        page.getByLabel('掛牌日期'),
        page.getByRole('button', { name: '清除臺銀匯率檔案', exact: true }),
        page.getByRole('button', { name: '臺銀匯率 CSV', exact: true }),
      ]) {
        const b = await el.boundingBox();
        assert.ok(
          b && b.width >= 44 && b.height >= 44,
          'market touch target >=44px',
        );
      }
    }
    const a = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    if (a.violations.length) {
      await page.screenshot({ path: output + '/debug-' + name + '.png' });
      await writeFile(
        output + '/debug-' + name + '.json',
        JSON.stringify(a.violations, null, 2),
      );
    }
    assert.deepEqual(a.violations, [], name);
    const filename = `market-${name}-${w}x${h}-${theme}.png`;
    await page.screenshot({ path: output + '/' + filename, fullPage: false });
    states.push({
      state: name,
      width: w,
      height: h,
      theme,
      horizontalOverflow: overflow,
      violations: a.violations,
      screenshot: filename,
    });
  }

  const selectLedger = async (id) =>
    page.evaluate(
      (v) => globalThis.localStorage.setItem('finmichi-ledger', v),
      id,
    );
  const go = async (url) => {
    await page.goto(origin + url);
    await settle();
  };
  const fxPage = '/admin/exchange-rates';
  // Real upload: preview/cancel do not write; confirm commits only market cache, never accounting.
  await go(fxPage);
  const audits = async () =>
    Number(
      (
        await db`SELECT count(*)::int n FROM audit_logs WHERE action='market.fx_upload' AND user_id=${actor}`
      )[0].n,
    );
  const before = await audits();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'manual.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  assert.equal(await page.getByLabel('掛牌日期').inputValue(), '');
  assert.equal(
    await page
      .getByRole('button', { name: '預覽匯率 CSV', exact: true })
      .isDisabled(),
    true,
  );
  await page.getByLabel('掛牌日期').fill(day);
  await page.getByRole('button', { name: '預覽匯率 CSV', exact: true }).click();
  await settle();
  await page.getByRole('region', { name: '匯率上傳預覽' }).waitFor();
  assert.equal(await audits(), before);
  await page.getByRole('button', { name: '確認上傳匯率', exact: true }).click();
  await page
    .getByRole('dialog', { name: '確認上傳臺銀匯率' })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  assert.equal(await audits(), before);
  await page.getByRole('button', { name: '確認上傳匯率', exact: true }).click();
  let releaseUpload, enteredUpload;
  const uploadGate = new Promise((r) => {
      releaseUpload = r;
    }),
    uploadEntered = new Promise((r) => {
      enteredUpload = r;
    });
  const uploadPath = `**/api/ledgers/${ledger.id}/market/fx-upload`;
  await page.route(uploadPath, async (route) => {
    enteredUpload();
    await uploadGate;
    await route.continue();
  });
  const dialog = page.getByRole('dialog', { name: '確認上傳臺銀匯率' });
  await dialog
    .getByRole('button', { name: '更新市場匯率', exact: true })
    .click();
  await uploadEntered;
  assert.equal(
    await dialog
      .getByRole('button', { name: '取消', exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await audits(), before);
  releaseUpload();
  await dialog.waitFor({ state: 'hidden' });
  await settle();
  await page.unroute(uploadPath);
  assert.equal(await audits(), before + 1);
  assert.equal(
    (await reportService(db).balance(actor, ledger.id, { as_of: day })).totals
      .net_worth,
    '3350.00',
  );
  const bookCounts = JSON.stringify(
    (
      await db`SELECT (SELECT count(*) FROM transactions WHERE ledger_id=${ledger.id}) tx,(SELECT count(*) FROM transaction_entries WHERE ledger_id=${ledger.id}) entries`
    )[0],
  );
  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.evaluate(
        (v) => globalThis.localStorage.setItem('finmichi-theme', v),
        theme,
      );
      await selectLedger(ledger.id);
      await go('/reports/balance-sheet?as_of=' + day);
      await page.getByText('市值淨值', { exact: true }).waitFor();
      assert.match(await page.locator('.market-kpis').innerText(), /3,442.50/);
      await page
        .getByText('無行情（以帳面值代替）', { exact: true })
        .first()
        .waitFor();
      await capture('balance', w, h, theme);
      await db`UPDATE market_fx_rates SET rate_date=${oldDay}`;
      await db`UPDATE market_fetch_runs SET status='blocked_by_source',data_date=${oldDay} WHERE source='bot'`;
      await page.reload();
      await settle();
      await page
        .getByText('臺銀匯率無法自動取得，請手動上傳 CSV', { exact: true })
        .waitFor();
      await capture('stale', w, h, theme);
      await db`UPDATE market_fx_rates SET rate_date=${day}`;
      await db`UPDATE market_fetch_runs SET status='success',data_date=${day} WHERE source='bot'`;
      await db`INSERT INTO market_fx_rates(rate_date,currency,source,spot_buy,spot_sell) VALUES (${day},'EUR','bot','35.5','35.5')`;
      await selectLedger(cross.id);
      await go('/reports/balance-sheet?as_of=' + day);
      await page.getByText(/交叉匯率（臺銀）/).waitFor();
      await capture('cross', w, h, theme);
      await db`DELETE FROM market_fx_rates WHERE currency='EUR'`;
      await selectLedger(ledger.id);
      await go(fxPage);
      await page.getByRole('heading', { name: '最新臺銀匯率' }).waitFor();
      await capture('rates', w, h, theme);
      const tpexStatus = page
        .locator('.market-source-status')
        .filter({ has: page.getByText('櫃買中心', { exact: true }) });
      assert.equal(
        await tpexStatus.locator('.market-warning').count(),
        0,
        'unrelated missing quotes do not warn',
      );
      await tpexStatus.locator('summary').click();
      await tpexStatus.getByText(/來源中 99 筆沒有成交價.*不影響/).waitFor();
      await capture('source-complete', w, h, theme);
      await db`DELETE FROM market_prices WHERE market='TPEx' AND symbol='9999Z'`;
      await page.reload();
      await settle();
      await tpexStatus
        .getByText(/目前帳本有 1 個未封存證券缺少最新價格/)
        .waitFor();
      await capture('source-missing', w, h, theme);
      await db`DELETE FROM market_fetch_runs WHERE source='tpex'`;
      await page.reload();
      await settle();
      await page
        .getByText(
          '尚未取得來源行情，目前帳本有 1 個未封存證券缺少最新價格。',
          { exact: true },
        )
        .waitFor();
      await capture('source-not-fetched', w, h, theme);
      await db`INSERT INTO market_fetch_runs(source,status,data_date,received_date,error_code,row_count,skipped_no_price) VALUES ('tpex','warning',${day},${day},'many_missing_prices',100,99)`;

      await db`INSERT INTO market_prices(trade_date,market,symbol,close,source) VALUES (${day},'TPEx','9999Z',10,'tpex')`;
      await db`INSERT INTO market_fetch_runs(source,status,error_code,blocked_attempts,next_retry_at) VALUES ('twse','blocked_by_source','blocked_by_source',2,NULL) ON CONFLICT(source) DO UPDATE SET status='blocked_by_source',error_code='blocked_by_source',next_retry_at=NULL`;
      await page.reload();
      await settle();
      await page
        .getByText('行情來源暫時阻擋自動取得，保留既有資料；不會繞過驗證。', {
          exact: true,
        })
        .waitFor();
      await capture('twse-blocked', w, h, theme);
      await db`DELETE FROM market_fetch_runs WHERE source='twse'`;

      await db`UPDATE market_fetch_runs SET status='error',error_code='market_data_invalid',next_retry_at=${day + 'T02:05:00Z'} WHERE source='bot'`;
      await page.reload();
      await settle();
      await page
        .getByText('來源資料格式不正確，整批資料未寫入。 保留既有資料。', {
          exact: true,
        })
        .waitFor();
      assert.match(
        await page.locator('.market-retry').innerText(),
        /market_data_invalid.*10:05/s,
      );
      await capture('source-error', w, h, theme);
      await db`UPDATE market_fetch_runs SET status='error',error_code='dns_failed' WHERE source='bot'`;
      await page.reload();
      await settle();
      await page.getByText(/無法解析行情來源網址/).waitFor();
      await capture('source-dns', w, h, theme);
      await db`UPDATE market_fetch_runs SET status='blocked_by_source',error_code='blocked_by_source',next_retry_at=NULL WHERE source='bot'`;
      await page.reload();
      await settle();
      await page.getByText(/今日已停止自動重試，可手動上傳 CSV/).waitFor();
      await capture('source-blocked', w, h, theme);
      await db`UPDATE market_fetch_runs SET status='success',error_code=NULL,next_retry_at=NULL WHERE source='bot'`;
      await page.reload();
      await settle();

      await page.locator('input[type="file"]').setInputFiles({
        name: filename,
        mimeType: 'text/csv',
        buffer: Buffer.from(csv),
      });
      await page
        .getByRole('button', { name: '預覽匯率 CSV', exact: true })
        .click();
      await settle();
      await capture('preview', w, h, theme);
      await page
        .getByRole('button', { name: '確認上傳匯率', exact: true })
        .click();
      await capture('confirm', w, h, theme);
      await page
        .getByRole('dialog', { name: '確認上傳臺銀匯率' })
        .getByRole('button', { name: '取消', exact: true })
        .click();
      await page.route(endpoint, (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"rates":[],"runs":[]}',
        }),
      );
      await page.reload();
      await settle();
      await capture('empty', w, h, theme);
      await page.unroute(endpoint);
      await page.route(endpoint, (r) =>
        r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"error":"request_failed"}',
        }),
      );
      await page.reload();
      await settle();
      await capture('error', w, h, theme);
      await page.unroute(endpoint);
      await page.getByRole('button', { name: '重試', exact: true }).click();
      await settle();
      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      await page.route(endpoint, async (r) => {
        await gate;
        await r.continue();
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page
        .getByRole('status', { name: '行情載入中', exact: true })
        .waitFor();
      await capture('loading', w, h, theme);
      release();
      await settle();
      await page.unroute(endpoint);
    }
  assert.equal(
    JSON.stringify(
      (
        await db`SELECT (SELECT count(*) FROM transactions WHERE ledger_id=${ledger.id}) tx,(SELECT count(*) FROM transaction_entries WHERE ledger_id=${ledger.id}) entries`
      )[0],
    ),
    bookCounts,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(states.length, 128);
  await writeFile(
    output + '/matrix.json',
    JSON.stringify(
      {
        synthetic: true,
        states,
        browserErrors: errors,
        externalRequests: external,
        accountingWrites: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    'Market UX PASS 128 PNG; 4 sizes x 2 themes; revaluation/cross/missing/stale/upload/cancel/commit; axe0/overflow0/external0/accountingWrites0',
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
