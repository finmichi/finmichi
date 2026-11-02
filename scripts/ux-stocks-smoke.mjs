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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-stocks';
await mkdir(output, { recursive: true });
const issuer = `https://stocks-${Date.now()}.synthetic.invalid`,
  origin = 'https://localhost:18450';
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
    }),
    empty = await ledgerService(db).create(actor, { name: '合成空投資帳本' });
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
  const prior = new Date(day + 'T00:00:00Z');
  prior.setUTCDate(prior.getUTCDate() - 1);
  const earlier = prior.toISOString().slice(0, 10);
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
  await app.listen({ host: '127.0.0.1', port: 18450 });
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
    const screenshot = `stocks-${state}-${w}x${h}-${theme}.png`;
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
  // Real UI buy → preview → write, then generic transaction edit enters the managed editor.
  await go('/?entry=new');
  await page.getByRole('button', { name: '股票', exact: true }).click();
  await settle();
  await pick('證券', '9999A 合成測試股票');
  await page.getByLabel('股數', { exact: true }).fill('10');
  await page.getByLabel('成交價格', { exact: true }).fill('30');
  await pick('交割帳戶', '合成交割銀行');
  await pick('投資費用科目（業外支出）', '合成投資費用');
  await page.getByLabel('股數', { exact: true }).fill('0');
  await page.getByRole('button', { name: '預覽股票分錄' }).click();
  await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name: '重試', exact: true }).click();
  await settle();
  assert.equal(
    await page.getByLabel('股數', { exact: true }).inputValue(),
    '0',
    'retry preserves invalid input for correction',
  );
  await page.getByLabel('股數', { exact: true }).fill('10');
  await page.getByRole('button', { name: '預覽股票分錄' }).click();
  await page.getByRole('button', { name: '儲存股票紀錄' }).waitFor();
  assert.match(
    await page.locator('[aria-label="股票分錄預覽"]').innerText(),
    /NT\$ 300\.00/,
  );
  await page.getByRole('button', { name: '儲存股票紀錄' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const [saved] =
    await db`SELECT id,transaction_id,quantity::text,gross::text FROM security_trades WHERE security_id=${s.id} ORDER BY sequence DESC LIMIT 1`;
  assert.ok(saved.transaction_id);
  assert.equal(saved.quantity, '10');
  assert.equal(saved.gross, '300.00');
  await go('/transactions?entry=' + saved.transaction_id);
  await page.getByRole('heading', { name: '修改股票紀錄' }).waitFor();
  await page.getByLabel('股數', { exact: true }).fill('11');
  await page.getByRole('button', { name: '關閉記帳' }).click();
  await page.getByRole('button', { name: '繼續編輯', exact: true }).click();
  await page.getByRole('button', { name: '關閉記帳' }).click();
  await page.getByRole('button', { name: '捨棄變更', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await go('/investments/' + s.id + '?as_of=' + day);
  await page.getByRole('button', { name: '手動價格設定', exact: true }).click();
  assert.ok(new URL(page.url()).pathname === '/admin/investment-settings');
  await page.getByLabel('手動價格', { exact: true }).fill('21');
  const [priceResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url() === origin + `/api/ledgers/${l.id}/manual-prices` &&
        r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: '儲存手動價格', exact: true }).click(),
  ]);
  assert.equal(priceResponse.status(), 200);
  await page.getByText('手動價格已儲存', { exact: true }).waitFor();
  await settle();
  const [manual] =
    await db`SELECT price::text FROM manual_prices WHERE ledger_id=${l.id} AND symbol=${s.symbol}`;
  assert.equal(manual.price, '21.000000');
  await go('/investments/' + s.id + '?as_of=' + day);
  await page.getByRole('button', { name: '股票記帳 合成測試股票' }).click();
  await pick('股票動作', '賣出');
  await page.getByLabel('股數', { exact: true }).fill('2');
  await page.getByLabel('成交價格', { exact: true }).fill('40');
  await page.getByLabel('手續費', { exact: true }).fill('1');
  await page.getByLabel('證交稅', { exact: true }).fill('1');
  await pick('交割帳戶', '合成交割銀行');
  await pick('投資費用科目（業外支出）', '合成投資費用');
  await pick('投資損益科目（業外收入）', '合成投資損益');
  await page.getByRole('button', { name: '預覽股票分錄' }).click();
  await page.locator('[aria-label="股票分錄預覽"]').waitFor();
  assert.match(
    await page.locator('[aria-label="股票分錄預覽"]').innerText(),
    /NT\$ 78\.00/,
  );
  await page.getByRole('button', { name: '儲存股票紀錄' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const [sold] =
    await db`SELECT position_quantity::text FROM security_trades WHERE security_id=${s.id} ORDER BY sequence DESC LIMIT 1`;
  assert.equal(sold.position_quantity, '83');
  await page
    .getByRole('button', { name: '股票記帳 合成測試股票', exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: '股票記帳 合成測試股票', exact: true })
      .isEnabled(),
    true,
    'successful stock save releases the parent busy state without reload',
  );
  await page.getByRole('button', { name: '股票記帳 合成測試股票' }).click();
  await page.getByLabel('股數', { exact: true }).waitFor();
  await page.getByRole('button', { name: '關閉編輯', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
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
      if (w < 900) {
        await go('/');
        const nav = page.getByRole('navigation', {
          name: '手機主導覽',
          exact: true,
        });
        assert.deepEqual(await nav.getByRole('link').allTextContents(), [
          '總覽',
          '明細',
          '報表',
          '投資',
          '管理',
        ]);
        for (const target of await nav.locator('a,button').all()) {
          const b = await target.boundingBox();
          assert.ok(
            b && b.width >= 44 && b.height >= 44,
            'bottom nav touch target >=44px',
          );
          assert.ok(
            await target.evaluate((e) => e.scrollWidth <= e.clientWidth),
            'nav label is not clipped',
          );
        }
        assert.deepEqual(
          await nav
            .locator('a,button')
            .evaluateAll((els) => els.map((e) => e.tagName)),
          ['A', 'A', 'BUTTON', 'A', 'A', 'A'],
        );
        await nav.getByRole('link', { name: '投資', exact: true }).click();
        await settle();
        await page
          .getByRole('heading', { name: '投資持股', exact: true })
          .waitFor();
        const detail = page
          .locator(`a[href^="/investments/${s.id}?"]`)
          .filter({ visible: true });
        await detail.click();
        await page
          .getByRole('heading', {
            name: s.symbol + ' ' + s.name,
            exact: true,
            level: 2,
          })
          .waitFor();
        await page
          .getByRole('button', { name: '返回持股', exact: true })
          .click();
        await settle();
        assert.equal(new URL(page.url()).pathname, '/investments');
      } else await go('/investments?as_of=' + day);
      await page
        .getByRole('heading', { name: '投資持股', exact: true })
        .waitFor();
      assert.match(
        await page
          .locator(w >= 900 ? '.stock-desktop' : '.stock-mobile')
          .innerText(),
        /無行情/,
      );
      const currentNav = page
        .getByRole('navigation', {
          name: w < 900 ? '手機主導覽' : '主導覽',
          exact: true,
        })
        .getByRole('link', { name: '投資', exact: true });
      assert.equal(await currentNav.getAttribute('aria-current'), 'page');
      await capture('holdings', w, h, theme);
      await go(
        '/investments?view=realized-gains&date_from=' +
          day +
          '&date_to=' +
          day +
          '&ignored=not-forwarded',
      );
      await page
        .getByRole('heading', { name: '已實現損益', exact: true })
        .waitFor();
      await page
        .getByRole('heading', { name: '期間已入帳損益', exact: true })
        .waitFor();
      const [sum] =
        await db`SELECT coalesce(sum(realized_gain),0)::text total FROM security_trades WHERE ledger_id=${l.id} AND trade_date=${day} AND transaction_id IS NOT NULL`;
      const profit = await page.locator('.stock-values').allInnerTexts();
      assert.ok(profit.length > 0);
      assert.ok(
        await page.getByRole('button', { name: '產生損益報表' }).isEnabled(),
      );
      await page.getByRole('button', { name: '產生損益報表' }).click();
      await settle();
      assert.ok(!new URL(page.url()).searchParams.has('ignored'));
      assert.equal(new URL(page.url()).searchParams.get('date_from'), day);
      const negative = sum.total.startsWith('-'),
        [whole, fraction = ''] = sum.total.replace(/^-/, '').split('.');
      const expected =
        (negative ? '−' : '') +
        'NT$ ' +
        whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
        '.' +
        fraction.padEnd(2, '0');
      assert.equal(
        await page
          .getByRole('heading', { name: '期間已入帳損益', exact: true })
          .locator('xpath=following-sibling::strong[1]')
          .innerText(),
        expected,
      );
      assert.equal(
        await page
          .getByRole('heading', { name: '未入帳損益', exact: true })
          .locator('xpath=following-sibling::strong[1]')
          .innerText(),
        'NT$ 0.00',
      );
      await capture('realized', w, h, theme);
      await page.getByLabel('損益起日', { exact: true }).fill(earlier);
      await page.getByLabel('損益迄日', { exact: true }).fill(earlier);
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes('/reports/realized-gains?') &&
            new URL(r.url()).searchParams.get('date_to') === earlier,
        ),
        page.getByLabel('損益迄日', { exact: true }).press('Enter'),
      ]);
      await page
        .getByRole('heading', { name: '期間內尚無股票紀錄', exact: true })
        .waitFor();
      assert.equal(new URL(page.url()).searchParams.get('date_to'), earlier);
      await capture('realized-empty', w, h, theme);
      await page.reload();
      await settle();
      await page
        .getByRole('heading', { name: '期間已入帳損益', exact: true })
        .waitFor();
      await go('/investments?as_of=' + day);
      await page.getByRole('button', { name: '新增證券', exact: true }).click();
      assert.equal(new URL(page.url()).pathname, '/admin/investment-settings');
      assert.equal(
        await page
          .locator('a[href="/investments"][aria-current="page"]')
          .count(),
        0,
      );
      await page
        .getByRole('button', { name: '新增證券', exact: true })
        .waitFor();
      await settle();
      await capture('settings-page', w, h, theme);
      await page.getByRole('button', { name: '新增證券', exact: true }).click();
      await page
        .getByRole('textbox', { name: '證券名稱', exact: true })
        .waitFor();
      await capture('settings', w, h, theme);
      await page.getByRole('button', { name: '關閉編輯', exact: true }).click();
      await go('/investments?as_of=' + day);
      const endpoint = `**/api/ledgers/${l.id}/reports/holdings?*`;
      await page.route(endpoint, (r) =>
        r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"error":"request_failed"}',
        }),
      );
      await page.reload();
      await settle();
      await page.getByRole('alert').waitFor();
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
        .getByRole('status', { name: '載入投資資料', exact: true })
        .waitFor();
      await capture('loading', w, h, theme);
      release();
      await settle();
      await page.unroute(endpoint);
      await go('/investments/' + s.id + '?as_of=' + day);
      await page.getByRole('heading', { name: '交易與股數紀錄' }).waitFor();
      await capture('detail', w, h, theme);
      await page
        .getByRole('button', { name: '手動價格設定', exact: true })
        .click();
      await page
        .getByRole('heading', { name: '手動價格', exact: true })
        .scrollIntoViewIfNeeded();
      await capture('manual', w, h, theme);
      await go('/investments/' + s.id + '?as_of=' + day);
      await page.getByRole('button', { name: '股票記帳 合成測試股票' }).click();
      const drawer = await page.locator('.admin-editor').boundingBox();
      assert.ok(
        drawer && Math.abs(drawer.width - (w < 900 ? w : 420)) < 1,
        '420px desktop/full-screen phone stock entry',
      );
      await page.getByLabel('股數', { exact: true }).fill('100');
      await page.getByLabel('成交價格', { exact: true }).fill('30');
      await page.getByLabel('交易日期', { exact: true }).fill(earlier);
      await pick('交割帳戶', '合成交割銀行');
      await pick('投資費用科目（業外支出）', '合成投資費用');
      await page.getByRole('button', { name: '預覽股票分錄' }).click();
      await page.locator('[aria-label="股票分錄預覽"]').waitFor();
      assert.match(
        await page.locator('[aria-label="股票分錄預覽"]').innerText(),
        /將重算/,
      );
      await capture('preview', w, h, theme);
      await page.getByRole('button', { name: '儲存股票紀錄' }).click();
      await page.getByRole('button', { name: '確認重算並儲存' }).waitFor();
      await capture('recalculate', w, h, theme);
      await page
        .getByRole('button', { name: '取消', exact: true })
        .last()
        .click();
      await page.getByRole('button', { name: '關閉編輯', exact: true }).click();
      await page.getByRole('button', { name: '捨棄變更', exact: true }).click();
      await go('/reports/balance-sheet?as_of=' + day);
      await page.getByText('市值淨值', { exact: true }).waitFor();
      assert.match(
        await page.locator('body').innerText(),
        /手動價格.*21\.0000/,
      );
      await capture('balance', w, h, theme);
      // Local preferences survive reload without selecting a real account.
      await page.evaluate(
        (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
        usd.id,
      );
      await page.reload();
      await settle();
      await go('/investments');
      await page
        .getByText('股票功能目前僅支援本位幣為新臺幣的帳本', { exact: true })
        .waitFor();
      await capture('non-twd', w, h, theme);
      await page.evaluate(
        (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
        empty.id,
      );
      await page.reload();
      await settle();
      await go('/investments');
      await page.getByRole('heading', { name: '尚無證券' }).waitFor();
      await capture('empty', w, h, theme);
      await page.evaluate(
        (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
        l.id,
      );
      await page.reload();
      await settle();
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(states.length, 112);
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
    'Stocks UX PASS 112 PNG; 4 sizes x2 themes; buy/preview/write/managed edit/dirty/recalculate/manual/missing/nonTWD; axe0/overflow0/external0',
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
