// SPDX-License-Identifier: AGPL-3.0-only
// FB-001: real wheel/touch input against synthetic app pages, never NAS data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  ledgerService,
  itemService,
  transactionService,
  securityService,
  budgetService,
} from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const address = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1'].includes(address.hostname) ||
  !['/synthetic', '/life_test'].includes(address.pathname)
)
  throw new Error('Local synthetic DB only');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-scroll-chaining';
await mkdir(output, { recursive: true });
const origin = 'https://localhost:18453',
  issuer = `https://scroll-chain-${Date.now()}.synthetic.invalid`;
const discovery = createServer((_q, r) => {
  r.setHeader('content-type', 'application/json');
  r.end(
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
const results = [],
  errors = [],
  external = [];
const day = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei',
}).format(new Date());
try {
  discovery.listen(0, '127.0.0.1');
  await once(discovery, 'listening');
  db = connect(databaseUrl);
  await migrate(db);
  const session = sessionService(db, ['owner']),
    token = await session.login(issuer, 'owner'),
    actor = (await session.authenticate(token)).id;
  const ledger = await ledgerService(db).create(actor, {
      name: '合成捲動驗收',
    }),
    items = itemService(db),
    tx = transactionService(db),
    securities = securityService(db);
  const mk = (name, kind, extra = {}) =>
    items.create(actor, ledger.id, { name, kind, currency: 'TWD', ...extra });
  const bank = await mk('合成銀行', 'asset'),
    holding = await mk('合成股票', 'asset', { securities: true }),
    fee = await mk('合成投資費用', 'expense', { non_operating: true }),
    gain = await mk('合成投資損益', 'income', { non_operating: true });
  const parent = await mk('合成預算父科目', 'expense');
  const child = await mk('合成預算子科目', 'expense', { parent_id: parent.id });
  for (const item of [parent, child])
    await budgetService(db).distribute(actor, ledger.id, {
      item_id: item.id,
      year: Number(day.slice(0, 4)),
      total: '1200',
    });
  for (let i = 0; i < 40; i++) {
    const asset = await mk('合成資產' + i, 'asset'),
      expense = await mk('合成費用' + i, 'expense');
    await tx.create(actor, ledger.id, {
      occurred_on: day,
      memo: '合成捲動交易' + i,
      entries: [
        { item_id: asset.id, amount: '-100' },
        { item_id: expense.id, amount: '100' },
      ],
    });
    const sec = await securities.create(actor, ledger.id, {
      name: '合成持股' + i,
      symbol: 'Z' + String(i).padStart(4, '0'),
      market: 'TWSE',
      kind: 'stock',
      item_id: holding.id,
    });
    const trade = {
      trade_type: 'buy',
      trade_date: day,
      quantity: '1',
      price: '10',
      fee: '0',
      tax: '0',
      settlement_item_id: bank.id,
      expense_item_id: fee.id,
      gain_item_id: gain.id,
    };
    const preview = await securities.preview(actor, ledger.id, sec.id, {
      operation: 'create',
      trade,
    });
    await securities.apply(actor, ledger.id, sec.id, 'create', {
      trade,
      preview_hash: preview.preview_hash,
      confirm_recalculation: true,
    });
    const currency =
      'Z' +
      String.fromCharCode(65 + Math.floor(i / 26)) +
      String.fromCharCode(65 + (i % 26));
    await db`INSERT INTO market_fx_rates(rate_date,currency,spot_buy,spot_sell,source) VALUES(${day},${currency},30,31,'bot') ON CONFLICT DO NOTHING`;
  }
  app = await createApp(
    {
      databaseUrl,
      publicUrl: origin,
      issuer,
      clientId: 'synthetic',
      allowedSubjects: ['owner'],
      trustProxy: 0,
      version: 'scroll-test',
      mockInternalUrl: `http://127.0.0.1:${discovery.address().port}`,
      tlsKey: 'deploy/local/tls-key',
      tlsCert: 'deploy/local/tls-cert',
    },
    db,
  );
  await app.listen({ host: '127.0.0.1', port: 18453 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {}),
    args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  async function contextFor(width, height, theme, touch = false) {
    const c = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height },
      colorScheme: theme,
      reducedMotion: 'reduce',
      hasTouch: touch,
      isMobile: touch,
    });
    await c.addCookies([
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
    await c.addInitScript(
      ({ id, theme, origin }) => {
        if (globalThis.location.origin !== origin) return;
        globalThis.localStorage.setItem('finmichi-ledger', id);
        globalThis.localStorage.setItem('finmichi-theme', theme);
      },
      { id: ledger.id, theme, origin },
    );
    c.on('page', (p) => {
      p.on('pageerror', (e) => errors.push(e.message));
      p.on('request', (r) => {
        if (!['localhost', '127.0.0.1'].includes(new URL(r.url()).hostname))
          external.push(r.url());
      });
    });
    return c;
  }
  const main = (page) =>
    page.getByRole('region', { name: '主內容', exact: true });
  const metrics = (loc) =>
    loc.evaluate((el) => ({
      top: el.scrollTop,
      height: el.scrollHeight,
      client: el.clientHeight,
    }));
  async function load(page, path, label) {
    await page.goto(origin + path);
    await page.getByRole('region', { name: label, exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => globalThis.document.fonts.ready);
    // Negative-control only: restores the old defect without altering the source.
    if (process.env.FINMICHI_SCROLL_NEGATIVE === '1')
      await page.addStyleTag({
        content:
          '.edge-scroll > .edge-viewport {overscroll-behavior:contain !important}',
      });
  }
  async function point(page, region) {
    const b = await region.boundingBox(),
      m = await main(page).boundingBox();
    assert.ok(b && m);
    const left = Math.max(b.x, m.x),
      right = Math.min(b.x + b.width, m.x + m.width),
      top = Math.max(b.y, m.y),
      bottom = Math.min(b.y + b.height, m.y + m.height);
    assert.ok(right > left && bottom - top > 10, 'wheel target is visible');
    await page.mouse.move(
      left + (right - left) * 0.6,
      top + Math.min(100, (bottom - top) / 2),
    );
  }
  async function wheelTo(page, bottom) {
    for (let i = 0; i < 65; i++) {
      await page.mouse.wheel(0, bottom ? 900 : -900);
      await page.waitForTimeout(60);
      const m = await metrics(main(page));
      if (bottom ? m.top + m.client >= m.height - 2 : m.top <= 2) return m;
    }
    assert.fail(
      'wheel did not reach ' +
        (bottom ? 'bottom' : 'top') +
        ': ' +
        JSON.stringify(await metrics(main(page))),
    );
  }
  async function capture(page, name) {
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth ||
        [...globalThis.document.querySelectorAll('main *')].some((e) => {
          const r = e.getBoundingClientRect();
          return (
            r.width > 0 &&
            !e.closest(
              ".edge-scroll[data-axis='x'] > .edge-viewport, .edge-scroll[data-axis='both'] > .edge-viewport",
            ) &&
            (r.right > globalThis.innerWidth + 1 || r.left < -1)
          );
        }),
    );
    assert.equal(overflow, false, name + ' overflow');
    const axe = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .analyze();
    assert.deepEqual(axe.violations, [], name + ' contrast');
    await page.screenshot({ path: `${output}/${name}.png` });
  }
  const routes = [
    [
      '/reports/balance-sheet?as_of=' + day,
      '資產負債表資產明細',
      'balance',
      false,
    ],
    ['/investments', '持股表格', 'holdings', false],
    ['/admin/exchange-rates', '臺銀匯率表', 'rates', false],
    ['/transactions', '交易表格', 'transactions', true],
    ['/admin/budgets', '預算年度表格', 'budgets', true],
    [
      `/reports/profit-loss?date_from=${day.slice(0, 4)}-01-01&date_to=${day}&grain=month`,
      '損益表時段明細',
      'profit',
      false,
    ],
  ];
  for (const theme of ['light', 'dark']) {
    const c = await contextFor(1440, 900, theme),
      page = await c.newPage();
    page.setDefaultTimeout(15000);
    for (const [path, label, name, vertical] of routes) {
      await load(page, path, label);
      const region = page.getByRole('region', { name: label, exact: true });
      const before = await metrics(main(page));
      assert.ok(
        before.height > before.client + 2,
        name + ' page must overflow: ' + JSON.stringify(before),
      );
      if (vertical) {
        const inner = await metrics(region);
        assert.ok(
          inner.height > inner.client + 2,
          name + ' table must overflow',
        );
      }
      await region.scrollIntoViewIfNeeded();
      await point(page, region);
      const bottom = await wheelTo(page, true);
      assert.ok(
        bottom.top + bottom.client >= bottom.height - 2,
        name + ' page bottom',
      );
      if (vertical) {
        const innerBottom = await metrics(region);
        assert.ok(
          innerBottom.top + innerBottom.client >= innerBottom.height - 2,
          name + ' inner table bottom before chaining',
        );
      }
      // Reposition over the visible table when possible; never set scrollTop to pass an assertion.
      const box = await region.boundingBox();
      if (box.y < 900 && box.y + box.height > 90) await point(page, region);
      const top = await wheelTo(page, false);
      assert.ok(top.top <= 2, name + ' page top');
      const styles = await region.evaluate((el) => {
        const s = globalThis.getComputedStyle(el);
        return {
          x: s.overscrollBehaviorX,
          y: s.overscrollBehaviorY,
          scrollbar: s.scrollbarWidth,
        };
      });
      assert.equal(styles.y, 'auto');
      assert.equal(
        await main(page).evaluate(
          (el) => globalThis.getComputedStyle(el).scrollbarWidth,
        ),
        'thin',
      );
      assert.equal(styles.scrollbar, vertical ? 'thin' : 'none');
      const regions = page.locator('.edge-viewport:visible');
      for (const r of await regions.all()) {
        assert.equal(await r.getAttribute('tabindex'), '0');
        await r.focus();
        // Verify real sequential keyboard navigation returns into this region.
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        assert.equal(
          await r.evaluate((el) => globalThis.document.activeElement === el),
          true,
        );
      }
      await main(page).evaluate((el) => el.scrollTo(0, 0));
      await capture(page, name + '-' + theme);
      results.push({ name, theme, bottom, top, styles });
    }
    await c.close();
  }
  for (const theme of ['light', 'dark']) {
    const c = await contextFor(390, 844, theme, true),
      page = await c.newPage();
    page.setDefaultTimeout(15000);
    const cdp = await c.newCDPSession(page);
    for (const [path, label, name] of [
      routes[0],
      ['/transactions', '主內容', 'transaction-cards'],
    ]) {
      await load(page, path, label);
      await main(page).evaluate((el) => el.scrollTo(0, 0));
      const before = await metrics(main(page));
      assert.ok(before.height > before.client);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: 200, y: 650 }],
      });
      for (let y = 620; y >= 230; y -= 30) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: 200, y }],
        });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await page.waitForTimeout(250);
      const after = await metrics(main(page));
      assert.ok(after.top > before.top + 10, name + ' touch scroll');
      assert.equal(
        await main(page).evaluate(
          (el) => globalThis.getComputedStyle(el).scrollbarWidth,
        ),
        'none',
      );
      await capture(page, name + '-touch-' + theme);
      results.push({ name, theme, touch: true, before, after });
    }
    // Both overlays keep the main-scroll offset even at their lower boundary.
    for (const [button, label, close] of [
      [/^記一筆$/, '記帳內容', '關閉記帳'],
      [/篩選與工具（/, '進階篩選內容', '關閉篩選與工具'],
    ]) {
      await page.getByRole('button', { name: button }).click();
      const region = page.getByRole('region', { name: label, exact: true });
      await region.waitFor();
      await region.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.waitForTimeout(250);
      const before = await metrics(main(page));
      const b = await region.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(70);
      }
      const after = await metrics(main(page));
      assert.equal(after.top, before.top, label + ' background locked');
      assert.equal(
        await region.evaluate(
          (el) => globalThis.getComputedStyle(el).overscrollBehaviorY,
        ),
        'contain',
      );
      await capture(page, label + '-locked-' + theme);
      results.push({ label, theme, overlay: true, before, after });
      await page.getByRole('button', { name: close, exact: true }).click();
    }
    await c.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(
    output + '/results.json',
    JSON.stringify({ results, errors, external }, null, 2),
  );
  console.log(
    'Scroll chaining PASS: six desktop pages both directions/light-dark; touch; overlays; contrast; focus.',
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
