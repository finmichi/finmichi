// SPDX-License-Identifier: AGPL-3.0-only
import { revealItemOption } from './item-picker-test.mjs';
// Synthetic localhost HTTP→browser→DB acceptance, no real financial inputs.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  ledgerService,
  itemService,
  securityService,
  dividendService,
} from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const u = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1'].includes(u.hostname) ||
  !['/synthetic', '/life_test'].includes(u.pathname)
)
  throw new Error('Local synthetic DB only');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-dividends';
await mkdir(output, { recursive: true });
const issuer = `https://dividends-${Date.now()}.synthetic.invalid`,
  origin = 'https://localhost:18451';
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
  const sessions = sessionService(db, ['owner']),
    token = await sessions.login(issuer, 'owner'),
    actor = (await sessions.authenticate(token)).id,
    l = await ledgerService(db).create(actor, { name: '合成股票驗收' }),
    usd = await ledgerService(db).create(actor, {
      name: '合成非TWD股票限制',
      base_currency: 'USD',
    });
  const item = itemService(db),
    svc = securityService(db);
  const mk = (name, kind, extra = {}) =>
      item.create(actor, l.id, { name, kind, currency: 'TWD', ...extra }),
    bank = await mk('合成交割銀行', 'asset'),
    holding = await mk('合成股票科目', 'asset', { securities: true }),
    expense = await mk('合成投資費用', 'expense', { non_operating: true }),
    gain = await mk('合成投資損益', 'income', { non_operating: true }),
    s = await svc.create(actor, l.id, {
      name: '合成測試股票',
      symbol: '9999A',
      market: 'TWSE',
      kind: 'stock',
      item_id: holding.id,
    }),
    missing = await svc.create(actor, l.id, {
      name: '合成缺行情ETF',
      symbol: '9999B',
      market: 'TPEx',
      kind: 'etf',
      item_id: holding.id,
    });
  const day = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
  }).format(new Date());
  const data = {
    trade_type: 'buy',
    trade_date: day,
    quantity: '100',
    price: '10',
    fee: '10',
    tax: '0',
    settlement_item_id: bank.id,
    expense_item_id: expense.id,
    gain_item_id: gain.id,
  };
  const apply = async (sec, t) => {
    const p = await svc.preview(actor, l.id, sec, {
      operation: 'create',
      trade: t,
    });
    return svc.apply(actor, l.id, sec, 'create', {
      trade: t,
      preview_hash: p.preview_hash,
      confirm_recalculation: true,
    });
  };
  await apply(s.id, data);
  await apply(s.id, {
    ...data,
    trade_type: 'sell',
    quantity: '25',
    price: '20',
    fee: '1',
    tax: '2',
  });
  await apply(missing.id, { ...data, quantity: '1', price: '15', fee: '0' });
  await svc.price(actor, l.id, {
    market: 'TWSE',
    symbol: s.symbol,
    price_date: day,
    price: '20',
  });
  await dividendService(db).initialize(actor, l.id);
  await svc.create(actor, l.id, {
    symbol: '9999C',
    name: '合成已出清股票',
    market: 'TWSE',
    kind: 'stock',
    item_id: holding.id,
  });
  app = await createApp(
    {
      databaseUrl,
      publicUrl: origin,
      issuer,
      clientId: 'synthetic',
      allowedSubjects: ['owner'],
      trustProxy: 0,
      version: 'test',
      mockInternalUrl: `http://127.0.0.1:${discovery.address().port}`,
      tlsKey: 'deploy/local/tls-key',
      tlsCert: 'deploy/local/tls-cert',
    },
    db,
  );
  await app.listen({ host: '127.0.0.1', port: 18451 });
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
      value: token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  await context.addInitScript((id) => {
    if (!globalThis.localStorage.getItem('finmichi-ledger'))
      globalThis.localStorage.setItem('finmichi-ledger', id);
  }, l.id);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [],
    external = [],
    states = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!['localhost', '127.0.0.1'].includes(new URL(r.url()).hostname))
      external.push(r.url());
  });
  const settle = async () => {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => globalThis.document.fonts.ready);
  };
  const go = async (path) => {
    await page.goto(origin + path);
    await settle();
  };
  async function capture(state, w, h, theme) {
    await page.evaluate(() => globalThis.document.fonts.ready);
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    );
    assert.equal(overflow, false, state);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    if (axe.violations.length)
      await writeFile(
        output + '/debug-' + state + '.json',
        JSON.stringify(axe.violations, null, 2),
      );
    assert.deepEqual(axe.violations, [], state);
    const screenshot = `dividends-${state}-${w}x${h}-${theme}.png`;
    await page.screenshot({ path: output + '/' + screenshot });
    states.push({
      state,
      width: w,
      height: h,
      theme,
      screenshot,
      horizontalOverflow: overflow,
      violations: [],
    });
  }
  const pick = async (label, value) => {
    await page.getByRole('textbox', { name: label, exact: true }).click();
    await revealItemOption(page, value);
    await page.getByRole('option', { name: value, exact: true }).click();
  };

  const next = new Date(day + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  const tomorrow = next.toISOString().slice(0, 10);
  const path =
    '/investments?view=dividends&date_from=' +
    day +
    '&date_to=' +
    tomorrow +
    '&ignored=not-forwarded';
  await go('/admin/investment-settings?tab=codes');
  await page
    .getByRole('button', { name: '建立預設代碼與科目', exact: true })
    .click();
  await settle();
  await go(path);
  const sharePrefills = [];
  const sharesReply = (exDate) =>
    page.waitForResponse(async (reply) => {
      const url = new URL(reply.url());
      if (
        url.origin !== origin ||
        url.pathname !==
          `/api/ledgers/${l.id}/securities/${s.id}/dividend-shares` ||
        url.searchParams.get('ex_date') !== exDate ||
        reply.request().method() !== 'GET'
      )
        return false;
      await reply.finished();
      return true;
    });
  const recordShares = async (pending, expected) => {
    const reply = await pending;
    const { shares } = await reply.json();
    const observation = {
      ex_date: new URL(reply.url()).searchParams.get('ex_date'),
      status: reply.status(),
      shares,
    };
    sharePrefills.push(observation);
    console.log('Dividend share prefill', JSON.stringify(observation));
    await writeFile(
      output + '/share-prefills.json',
      JSON.stringify(sharePrefills, null, 2),
    );
    assert.equal(reply.status(), 200);
    assert.equal(shares, expected);
  };
  // Observe before opening: the intended security may already be the default.
  const todayShares = sharesReply(day);
  await page.getByRole('button', { name: '新增股利', exact: true }).click();
  await pick('股利股票', '合成測試股票');
  await recordShares(todayShares, '0');
  const sharesField = page.getByLabel('參與股數', { exact: true });
  assert.equal(await sharesField.inputValue(), '0');
  // Keep the existing 15-second budget across the response and DOM update.
  const deadline = Date.now() + 15000;
  const tomorrowShares = sharesReply(tomorrow);
  await page.getByLabel('除權息日', { exact: true }).fill(tomorrow);
  await page.getByLabel('發放日', { exact: true }).fill(tomorrow);
  await recordShares(tomorrowShares, '75');
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, 'Dividend share prefill exceeded existing timeout');
  await page.waitForFunction(
    (input) => input.value === '75',
    await sharesField.elementHandle(),
    { timeout: remaining },
  );
  assert.equal(
    await page.getByLabel('參與股數', { exact: true }).inputValue(),
    '75',
  );
  await page.getByLabel('每股配息', { exact: true }).fill('2');
  await page.getByLabel('應發總額', { exact: true }).fill('100');
  await page.getByLabel('扣繳稅額', { exact: true }).fill('10');
  await page.getByLabel('二代健保補充保費', { exact: true }).fill('2');
  await page.getByLabel('匯費', { exact: true }).fill('1');
  await page.getByRole('button', { name: '計算實發', exact: true }).click();
  assert.equal(
    await page.getByLabel('實發金額', { exact: true }).inputValue(),
    '87.00',
  );
  await pick('交割帳戶', '合成交割銀行');
  await pick('稅費科目', '稅費');
  await pick('投資費用科目', '投資費用');
  await page.getByRole('button', { name: '新增組成', exact: true }).click();
  await page.getByLabel('組成 1 金額', { exact: true }).fill('60');
  await page
    .getByLabel('組成 1 應稅（依通知自行確認）', { exact: true })
    .check();
  await page.getByRole('button', { name: '新增組成', exact: true }).click();
  await page.getByLabel('組成 2 代碼', { exact: true }).fill('free');
  await page.getByLabel('組成 2 名稱', { exact: true }).fill('合成自訂組成');
  await page.getByLabel('組成 2 金額', { exact: true }).fill('40');
  await page.getByLabel('股利備註', { exact: true }).fill('合成 UI 股利');
  await page.getByRole('button', { name: '預覽股利分錄', exact: true }).click();
  await page.getByTestId('dividend-preview').waitFor();
  assert.match(await page.getByTestId('dividend-preview').innerText(), /87.00/);
  await page.getByRole('button', { name: '儲存股利', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await settle();
  const [saved] =
    await db`SELECT id,transaction_id,pay_date::text,net_amount::text FROM dividends WHERE ledger_id=${l.id}`;
  assert.equal(saved.pay_date, tomorrow);
  assert.equal(saved.net_amount, '87.00');
  const [sum] =
    await db`SELECT sum(base_amount)::text total FROM transaction_entries WHERE transaction_id=${saved.transaction_id}`;
  assert.equal(BigInt(sum.total.replace('.', '')), 0n);
  await page.getByRole('button', { name: '所得代碼', exact: true }).click();
  await page.getByLabel('所得代碼', { exact: true }).fill('custom-UI');
  await page.getByLabel('代碼名稱', { exact: true }).fill('合成可編輯代碼');
  await pick('代碼預設收入科目', '股利收入');
  const [codeReply] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith('/income-codes') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: '儲存所得代碼', exact: true }).click(),
  ]);
  assert.equal(codeReply.status(), 200);
  await page
    .getByRole('status')
    .filter({ hasText: '所得代碼已儲存' })
    .waitFor();
  assert.equal(
    (
      await db`SELECT 1 FROM income_codes WHERE ledger_id=${l.id} AND code='custom-UI'`
    ).length,
    1,
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
      await go('/investments?as_of=' + day);
      await page
        .getByRole('heading', { name: '投資持股', exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole('link', { name: '9999C 合成已出清股票', exact: true })
          .count(),
        0,
      );
      assert.match(
        await page.getByRole('region', { name: '投資總計' }).innerText(),
        /1,515.00/,
      );
      assert.match(
        await page.getByRole('region', { name: '投資總計' }).innerText(),
        /772.50/,
      );
      await capture('holdings', w, h, theme);
      if (w >= 900) {
        await page
          .getByRole('button', { name: '依股數排序', exact: true })
          .click();
        assert.match(
          await page.locator('.holding-table tbody tr').first().innerText(),
          /9999B/,
        );
        await page
          .getByRole('button', { name: '依股數排序', exact: true })
          .click();
        assert.match(
          await page.locator('.holding-table tbody tr').first().innerText(),
          /9999A/,
        );
      }
      await page.getByLabel('顯示已出清', { exact: true }).check();
      await page
        .getByRole('link', { name: '9999C 合成已出清股票', exact: true })
        .waitFor();
      await capture('closed-visible', w, h, theme);
      await go(path);
      await page
        .getByRole('heading', { name: '依代碼彙總', exact: true })
        .waitFor();
      await capture('report', w, h, theme);
      await page.getByRole('button', { name: '所得代碼', exact: true }).click();
      await page.getByLabel('所得代碼', { exact: true }).waitFor();
      await capture('codes', w, h, theme);
      await go(path);
      await page
        .getByRole('button', { name: '編輯股利 ' + tomorrow, exact: true })
        .click();
      await page.getByLabel('參與股數', { exact: true }).waitFor();
      await capture('entry', w, h, theme);
      await page
        .getByRole('button', { name: '預覽股利分錄', exact: true })
        .click();
      await page.getByTestId('dividend-preview').waitFor();
      await capture('preview', w, h, theme);
      await page.getByLabel('股利備註', { exact: true }).fill('合成未儲存');
      await page.keyboard.press('Escape');
      await page
        .getByRole('button', { name: '放棄內容', exact: true })
        .waitFor();
      await capture('dirty', w, h, theme);
      await page.getByRole('button', { name: '放棄內容', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.route('**/reports/dividends?**', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'request_failed' }),
        }),
      );
      await go(path);
      await page.getByRole('alert').waitFor();
      await capture('error', w, h, theme);
      await page.unroute('**/reports/dividends?**');
      await page.getByRole('button', { name: '重試', exact: true }).click();
      await settle();
      await page
        .getByRole('heading', { name: '依代碼彙總', exact: true })
        .waitFor();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route('**/reports/dividends?**', async (route) => {
        await gate;
        await route.continue();
      });
      await page.goto(origin + path);
      await page
        .getByRole('status', { name: '載入股利', exact: true })
        .waitFor();
      await capture('loading', w, h, theme);
      release();
      await settle();
      await page.unroute('**/reports/dividends?**');
      await go(
        '/investments?view=dividends&date_from=1900-01-01&date_to=1900-01-02',
      );
      await page
        .getByRole('heading', { name: '期間內沒有股利', exact: true })
        .waitFor();
      await capture('empty', w, h, theme);
      await page.evaluate(
        (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
        usd.id,
      );
      await page.reload();
      await settle();
      await page
        .getByText('股票功能目前僅支援本位幣為新臺幣的帳本', { exact: true })
        .waitFor();
      await capture('non-twd', w, h, theme);
      await page.evaluate(
        (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
        l.id,
      );
      await page.reload();
      await settle();
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(states.length, 88);
  await writeFile(
    output + '/matrix.json',
    JSON.stringify(
      {
        synthetic: true,
        states,
        browserErrors: errors,
        externalRequests: external,
      },
      null,
      2,
    ),
  );
  console.log(
    'Dividends UX PASS 88 PNG; 4 sizes x2 themes; holdings totals/closed/sort; create/shares/preview/write/codes/edit/dirty/states; axe0/overflow0/external0',
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
