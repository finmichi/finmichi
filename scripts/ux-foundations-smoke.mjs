// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
// Synthetic localhost audit acceptance only; no real financial data.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  ledgerService,
  itemService,
  namedRecordService,
  transactionService,
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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-foundations';
await mkdir(output, { recursive: true });
const issuer = `https://ux-foundations-${Date.now()}.synthetic.invalid`;
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
  const ledgers = ledgerService(db),
    ledger = await ledgers.create(actor, { name: '合成操作紀錄帳本' });
  const cash = await itemService(db).create(actor, ledger.id, {
    name: '合成錢包',
    kind: 'asset',
    currency: 'TWD',
  });
  const expense = await itemService(db).create(actor, ledger.id, {
    name: '合成餐飲',
    kind: 'expense',
    currency: 'TWD',
  });
  for (let i = 0; i < 30; i++)
    await transactionService(db).create(actor, ledger.id, {
      occurred_on: '2026-10-16',
      memo: '合成日常紀錄 ' + i,
      entries: [
        { item_id: cash.id, amount: '-135' },
        { item_id: expense.id, amount: '135' },
      ],
    });
  for (let i = 0; i < 12; i++)
    await namedRecordService(db, 'payees').create(actor, ledger.id, {
      name: '合成收付人 ' + i,
    });
  await ledgers.create(actor, { name: '合成第二帳本' });
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
  const external = [],
    fonts = [],
    homeCharts = [];
  let matrixRoute = '';
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'https:' && u.hostname !== 'localhost')
      external.push(u.origin);
    if (r.resourceType() === 'font') fonts.push(u.pathname);
    if (matrixRoute === '/' && u.pathname.includes('report-charts-'))
      homeCharts.push(u.pathname);
  });
  const routes = [
    '/',
    '/transactions',
    '/reports/balance-sheet?as_of=2026-10-16',
    '/reports/income-summary',
    '/reports/category-statistics',
    '/admin',
    '/admin/ledgers',
    '/admin/items',
    '/admin/payees',
    '/admin/projects',
    '/admin/memo-templates',
    '/admin/import',
    '/admin/backup',
    '/admin/tokens',
    '/admin/audit',
    '/admin/system',
  ];
  // Unauthenticated brand matrix uses separate contexts: no session or theme carryover.
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      const loginContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const login = await loginContext.newPage();
      const pendingRequests = new Set();
      login.on('request', (r) => pendingRequests.add(r.url()));
      login.on('requestfinished', (r) => pendingRequests.delete(r.url()));
      login.on('requestfailed', (r) => pendingRequests.delete(r.url()));
      login.on('request', (request) => {
        const url = new URL(request.url());
        if (
          ['http:', 'https:'].includes(url.protocol) &&
          url.hostname !== 'localhost'
        )
          external.push(url.origin);
      });
      await login.goto('https://localhost:18444');
      await login.getByRole('link', { name: '登入', exact: true }).waitFor();
      try {
        await login.waitForLoadState('networkidle');
      } catch (error) {
        console.error('Login pending requests', [...pendingRequests]);
        await login.screenshot({ path: output + '/login-timeout.png' });
        throw error;
      }
      assert.equal(
        await login.getByRole('img', { name: 'FinMichi', exact: true }).count(),
        1,
      );
      const visibleImages = login.locator('.brand img:visible');
      assert.equal(await visibleImages.count(), 2);
      for (const image of await visibleImages.all())
        assert.equal(
          await image.evaluate(
            (element) => element.complete && element.naturalWidth > 0,
          ),
          true,
        );
      assert.equal(
        await login.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth,
        ),
        false,
      );
      assert.deepEqual(
        (
          await new AxeBuilder({ page: login })
            .withRules(['color-contrast'])
            .analyze()
        ).violations,
        [],
      );
      const safeArea = await login.evaluate(async () => {
        const image = new globalThis.Image();
        image.src = '/brand/maskable-512.png';
        await image.decode();
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = canvas.height = 512;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, 512, 512).data;
        let maxRadius = 0;
        for (let y = 0; y < 512; y++)
          for (let x = 0; x < 512; x++) {
            const i = (y * 512 + x) * 4;
            if (pixels[i + 3] !== 255) return false;
            // All visible foreground pixels must lie in the 80% safe circle.
            if (
              pixels[i] !== 15 ||
              pixels[i + 1] !== 45 ||
              pixels[i + 2] !== 61
            )
              maxRadius = Math.max(
                maxRadius,
                Math.hypot(x + 0.5 - 256, y + 0.5 - 256),
              );
          }
        return maxRadius > 0 && maxRadius <= 512 * 0.4;
      });
      assert.equal(
        safeArea,
        true,
        'opaque maskable foreground fits safe circle',
      );
      await login.screenshot({
        path: output + '/login-' + width + 'x' + height + '-' + theme + '.png',
        animations: 'disabled',
      });
      await loginContext.close();
    }
  const results = [];
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      for (const route of routes) {
        matrixRoute = route;
        await page.goto('https://localhost:18444' + route);
        await page.getByLabel('主題', { exact: true }).selectOption(theme);
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => globalThis.document.fonts.ready);
        assert.equal(
          await page.getByLabel('功能分頁', { exact: true }).count(),
          0,
        );
        await page.waitForLoadState('networkidle');
        const overflow = await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth,
        );
        assert.equal(overflow, false, route + ' ' + width + ' overflow');
        assert.equal(await page.locator('.sidebar').isVisible(), width >= 900);
        if (width < 900) {
          assert.equal(
            await page.locator('.topbar .brand-symbol:visible').count(),
            1,
          );
          assert.equal(
            await page.locator('.topbar .brand-wordmark:visible').count(),
            0,
          );
          const mark = await page
            .locator('.topbar .brand-symbol:visible')
            .boundingBox();
          const picker = await page
            .locator('.topbar')
            .getByRole('button', { name: '切換帳本', exact: true })
            .boundingBox();
          const header = await page.locator('.topbar').boundingBox();
          assert.ok(mark.width >= 28 && mark.height >= 28);
          assert.ok(picker.width >= 99, 'mark must not shrink ledger picker');
          assert.ok(header.height <= 64, 'mobile controls remain on one row');
          assert.ok(
            mark.x + mark.width <= picker.x,
            'mark and picker do not overlap',
          );
        } else {
          const cta = page.locator('.primary-action');
          assert.equal(await cta.getAttribute('data-variant'), 'filled');
          if (route === '/') {
            // Reach the CTA with real keyboard navigation, then activate it.
            await page.locator('.skip-link').focus();
            for (
              let n = 0;
              n < 12 &&
              !(await cta.evaluate(
                (el) => el === globalThis.document.activeElement,
              ));
              n++
            )
              await page.keyboard.press('Tab');
            assert.ok(
              await cta.evaluate(
                (el) => el === globalThis.document.activeElement,
              ),
            );
            const focus = await cta.evaluate((el) => {
              const style = globalThis.getComputedStyle(el);
              return {
                width: parseFloat(style.outlineWidth),
                color: style.outlineColor,
              };
            });
            assert.ok(focus.width >= 2);
            await page.keyboard.press('Enter');
            await page.getByRole('dialog').waitFor();
            await page.keyboard.press('Escape');
            await page.getByRole('dialog').waitFor({ state: 'hidden' });
          }
        }

        assert.equal(
          await page.locator('.bottom-nav').isVisible(),
          width < 900,
        );
        assert.equal(
          (await page.locator('[aria-current="page"]').count()) >= 1,
          true,
          route + ' current navigation',
        );
        const scan = await new AxeBuilder({ page })
          .withRules(['color-contrast'])
          .analyze();
        const violations = scan.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            summary: n.failureSummary,
          })),
        }));
        const name =
          (route.split('?')[0] === '/'
            ? 'home'
            : route.split('?')[0].slice(1).replaceAll('/', '-')) +
          '-' +
          width +
          'x' +
          height +
          '-' +
          theme;
        await page.screenshot({
          path: output + '/' + name + '.png',
          animations: 'disabled',
        });
        results.push({ route, width, height, theme, violations });
        await writeFile(
          output + '/matrix.json',
          JSON.stringify({ results, external, fonts }, null, 2),
        );
        assert.deepEqual(violations, [], name + ' axe color-contrast');
      }
      console.log(
        JSON.stringify({
          viewport: [width, height],
          theme,
          pages: routes.length,
          contrastViolations: 0,
          horizontalOverflow: false,
        }),
      );
    }
  // Shared horizontal EdgeScroll remains on query chips; obsolete management tabs are gone.
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto('https://localhost:18444/transactions');
  await page.waitForLoadState('networkidle');
  const tabs = page.getByLabel('交易類別篩選', { exact: true });
  const right = tabs
    .locator('..')
    .getByRole('button', { name: '向右捲動', exact: true });
  assert.equal(await right.getAttribute('tabindex'), '-1');
  await right.click();
  assert.equal(await tabs.evaluate((el) => el.scrollLeft > 0), true);
  await tabs.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await right.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://localhost:18444/admin/payees');
  await page.waitForLoadState('networkidle');
  const main = page.getByLabel('主內容', { exact: true });
  await main.hover();
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(
    () =>
      (globalThis.document.querySelector('[aria-label="主內容"]')?.scrollTop ??
        0) > 0,
  );
  await main.evaluate((el) => el.scrollTo({ top: 0 }));
  await page.getByRole('link', { name: '跳至主要內容', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(
    await main.evaluate((el) => el === globalThis.document.activeElement),
    true,
  );
  assert.equal(await page.locator('#main-content').count(), 1);
  await main.focus();
  await page.keyboard.press('PageDown');
  await page.waitForFunction(
    () =>
      (globalThis.document.querySelector('[aria-label="主內容"]')?.scrollTop ??
        0) > 0,
  );
  await main.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page
    .locator('.main-scroll')
    .getByRole('button', { name: '向下捲動', exact: true })
    .waitFor({ state: 'hidden' });
  // Exact responsive boundary and optional storage behavior.
  for (const width of [899, 900]) {
    await page.setViewportSize({ width, height: 844 });
    await page
      .locator('.sidebar')
      .waitFor({ state: width === 900 ? 'visible' : 'hidden' });
    assert.equal(await page.locator('.sidebar').isVisible(), width === 900);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: '管理', exact: true }).click();
  await page.getByRole('link', { name: '系統資訊', exact: false }).click();
  await page.getByRole('button', { name: '返回管理中心', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/admin');
  await page.goto(
    'https://localhost:18444/reports/balance-sheet?as_of=2026-10-16',
  );
  assert.equal(
    await page.getByLabel('基準日', { exact: true }).inputValue(),
    '2026-10-16',
  );
  await page.goto('https://localhost:18444');
  await page.getByRole('button', { name: '切換帳本', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '合成第二帳本 · TWD', exact: true })
    .click();
  await page.reload();
  await page.waitForLoadState('networkidle');
  assert.match(
    await page
      .getByRole('button', { name: '切換帳本', exact: true })
      .textContent(),
    /合成第二帳本/,
  );
  await page.getByLabel('主題', { exact: true }).selectOption('dark');
  await page.reload();
  await page.waitForLoadState('networkidle');
  assert.equal(
    await page.getByLabel('主題', { exact: true }).inputValue(),
    'dark',
  );
  await page.goto('https://localhost:18444/not-a-route');
  await page
    .getByRole('heading', { name: '找不到頁面', exact: true, level: 2 })
    .waitFor();
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.Storage.prototype, 'getItem', {
      value() {
        throw new Error('Storage disabled');
      },
    });
    Object.defineProperty(globalThis.Storage.prototype, 'setItem', {
      value() {
        throw new Error('Storage disabled');
      },
    });
  });
  await page.goto('https://localhost:18444');
  await page.waitForLoadState('networkidle');
  assert.equal(
    await page.getByLabel('主題', { exact: true }).inputValue(),
    'system',
  );
  await page.getByLabel('主題', { exact: true }).selectOption('light');
  await page.goto('https://localhost:18444/admin/tokens');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('主內容', { exact: true }).focus();
  await page.keyboard.press('n');
  await page.waitForURL(
    (url) =>
      url.pathname === '/admin/tokens' &&
      url.searchParams.get('entry') === 'new',
  );
  await page.getByRole('textbox', { name: /^來源金額/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  await page.getByLabel('主內容', { exact: true }).focus();
  await page.keyboard.press('/');
  await page.waitForURL((url) => url.pathname === '/transactions');
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[data-query-search]') ===
      globalThis.document.activeElement,
  );
  await page.goto('https://localhost:18444/transactions?keyword=synthetic');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('主內容', { exact: true }).focus();
  await page.keyboard.press('/');
  assert.equal(new URL(page.url()).searchParams.get('keyword'), 'synthetic');
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[data-query-search]') ===
      globalThis.document.activeElement,
  );
  assert.deepEqual(homeCharts, [], 'home does not load ECharts');
  assert.ok(
    fonts.some((p) => /noto-sans-tc-\d+-400-normal.*woff2/.test(p)),
    'segmented TC fonts loaded',
  );
  assert.deepEqual(external, []);
  assert.ok(fonts.length > 0);
  assert.deepEqual(errors, []);
  await writeFile(
    output + '/result.json',
    JSON.stringify(
      {
        screenshots: results.length + 8,
        brandLoginScreenshots: 8,
        maskableSafeCircle: true,
        allColorContrastPass: true,
        fontsSameOrigin: true,
        externalRequests: 0,
        homeChartRequests: homeCharts.length,
        edgeScrollPointerKeyboard: true,
        nativeWheel: true,
        skipLink: true,
        responsiveBoundary: [899, 900],
        deepLink: true,
        ledgerPersistence: true,
        themePersistence: true,
        storageDeniedResilient: true,
        keyboardShortcuts: true,
      },
      null,
      2,
    ),
  );
  console.log('UX foundation matrix and interactions PASS');
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (discovery.listening) {
    discovery.close();
    await once(discovery, 'close');
  }
  if (db) await db.end();
}
