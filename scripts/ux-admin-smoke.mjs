// SPDX-License-Identifier: AGPL-3.0-only
import { revealItemOption } from './item-picker-test.mjs';
// Synthetic HTTP → browser → DB acceptance; never point at a real ledger DB.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  ledgerService,
  itemService,
  namedRecordService,
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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-admin';
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
  await itemService(db).create(actor, ledger.id, {
    name: '合成美元資產',
    kind: 'asset',
    currency: 'USD',
    parent_id: fixture.assets,
  });
  for (const resource of ['payees', 'projects', 'memo_templates'])
    await namedRecordService(db, resource).create(actor, ledger.id, {
      name: '合成管理資料',
      ...(resource === 'memo_templates' ? { memo: '合成常用摘要' } : {}),
    });
  const emptyLedger = await ledgerService(db).create(actor, {
    name: '合成空帳本',
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

  const results = [],
    errors = [],
    external = [],
    requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname))
      external.push(u.origin);
    if (u.pathname.endsWith('.js')) requests.push(u.pathname);
  });
  await context.addInitScript(
    ({ id }) => {
      if (!globalThis.localStorage.getItem('finmichi-ledger'))
        globalThis.localStorage.setItem('finmichi-ledger', id);
    },
    { id: ledger.id },
  );
  async function capture(name, width, height, theme) {
    await page.evaluate(() => globalThis.document.fonts.ready);
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth ||
        Array.from(globalThis.document.querySelectorAll('.admin-content')).some(
          (e) => e.scrollWidth > e.clientWidth + 1,
        ),
    );
    assert.equal(overflow, false, name);
    const axe = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .analyze();
    assert.deepEqual(axe.violations, [], name);
    await page.screenshot({
      path: `${output}/${name}-${width}x${height}-${theme}.png`,
      fullPage: false,
    });
    results.push({
      name,
      width,
      height,
      theme,
      horizontalOverflow: overflow,
      violations: axe.violations,
    });
  }
  const routes = [
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
    '/admin/recurring',
    '/admin/budgets',
  ];
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
        await page.goto('https://localhost:18444' + route);
        await page.getByLabel('主題', { exact: true }).selectOption(theme);
        await page.waitForLoadState('networkidle');
        assert.equal(
          await page.getByLabel('功能分頁', { exact: true }).count(),
          0,
        );
        assert.equal(
          await page.locator('.sidebar').count(),
          width >= 900 ? 1 : 0,
        );
        if (width >= 900) {
          assert.equal(await page.locator('.admin-sidebar').count(), 1);
          assert.equal(
            Math.round(
              (await page.locator('.admin-sidebar').boundingBox()).width,
            ),
            200,
          );
          assert.ok(
            await page
              .locator('.admin-navigation [aria-current="page"]')
              .count(),
          );
        }
        if (width < 900 && route != '/admin') {
          await page
            .getByRole('button', { name: '返回管理中心', exact: true })
            .click();
          await page.waitForURL('**/admin');
          assert.equal(
            await page
              .getByRole('navigation', { name: '管理項目', exact: true })
              .count(),
            1,
          );
          await page.goto('https://localhost:18444' + route);
          await page.waitForLoadState('networkidle');
        }
        if (route === '/admin/ledgers') {
          assert.ok(
            (await page.locator('.admin-content').innerText()).includes(
              '未關帳',
            ),
          );
          assert.equal(
            await page
              .getByLabel('關帳日 ' + ledger.name, { exact: true })
              .count(),
            1,
          );
        }
        if (route === '/admin/items' && width < 900)
          assert.equal(
            await page
              .locator('.admin-content .report-card dt')
              .evaluateAll((nodes) =>
                nodes.every((el) => {
                  const r = globalThis.document.createRange();
                  r.selectNodeContents(el);
                  return r.getClientRects().length === 1;
                }),
              ),
            true,
            '管理卡片欄位標籤不換行',
          );
        await capture(
          route.slice(1).replaceAll('/', '-'),
          width,
          height,
          theme,
        );
      }
      // Every viewport/theme also verifies keyboard-capable editor and focus-returning confirmation.
      await page.goto('https://localhost:18444/admin/items');
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: '新增科目', exact: true }).click();
      await page
        .getByRole('dialog', { name: '新增科目', exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole('textbox', { name: '科目名稱', exact: true })
          .evaluate((e) => e === globalThis.document.activeElement),
        true,
      );
      await page
        .getByRole('textbox', { name: '科目名稱', exact: true })
        .fill('合成待新增科目');
      await capture('item-editor', width, height, theme);
      await page.keyboard.press('Escape');
      await page
        .getByRole('dialog', { name: '新增科目', exact: true })
        .waitFor({ state: 'hidden' });
      await page.goto('https://localhost:18444/admin/payees');
      await page.waitForLoadState('networkidle');
      const remove = page.getByRole('button', {
        name: '刪除收付人 合成管理資料',
        exact: true,
      });
      await remove.click();
      await page
        .getByRole('dialog', { name: '刪除收付人', exact: true })
        .waitFor();
      await capture('delete-confirmation', width, height, theme);
      await page
        .getByRole('button', { name: '保留收付人', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: '刪除收付人', exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(
        await remove.evaluate((e) => e === globalThis.document.activeElement),
        true,
      );
      // P2-1: real API writes, date / unlock confirmation and failure states in all 8 combinations.
      await page.goto('https://localhost:18444/admin/ledgers');
      await page.waitForLoadState('networkidle');
      const lockForm = page.getByRole('form', {
        name: '關帳設定 ' + ledger.name,
        exact: true,
      });
      const dateField = lockForm.getByLabel('關帳日 ' + ledger.name, {
        exact: true,
      });
      const submit = lockForm.getByRole('button', {
        name: '儲存關帳日 ' + ledger.name,
        exact: true,
      });
      const lockUrl = `https://localhost:18444/api/ledgers/${ledger.id}/lock`;
      async function persisted(expected) {
        await page.waitForLoadState('networkidle');
        assert.equal(
          (
            await db`SELECT locked_until::text FROM ledgers WHERE id=${ledger.id}`
          )[0].locked_until,
          expected,
        );
      }
      await dateField.fill('2026-09-30');
      let response = page.waitForResponse(lockUrl);
      await submit.click();
      assert.equal((await response).status(), 200);
      await page
        .getByRole('status')
        .filter({ hasText: '已儲存關帳日' })
        .waitFor();
      await persisted('2026-09-30');
      await capture('lock-saved', width, height, theme);
      await dateField.fill('2026-09-01');
      const writes = [];
      const listener = (r) => {
        if (r.url() === lockUrl && r.method() === 'PATCH')
          writes.push(r.postDataJSON());
      };
      page.on('request', listener);
      await submit.click();
      const unlock = page.getByRole('dialog', {
        name: '解鎖關帳',
        exact: true,
      });
      await unlock.waitFor();
      await unlock
        .getByText(
          '解鎖後，2026-09-01 之後到原關帳日 2026-09-30（含）的交易可再修改。',
          { exact: true },
        )
        .waitFor();
      await capture('unlock-confirmation', width, height, theme);
      await page.getByRole('button', { name: '保留關帳', exact: true }).click();
      await unlock.waitFor({ state: 'hidden' });
      assert.deepEqual(writes, []);
      await persisted('2026-09-30');
      assert.equal(
        await submit.evaluate((e) => e === globalThis.document.activeElement),
        true,
      );
      await submit.click();
      response = page.waitForResponse(lockUrl);
      await page
        .getByRole('button', { name: '確認解鎖關帳', exact: true })
        .click();
      assert.equal((await response).status(), 200);
      await unlock.waitFor({ state: 'hidden' });
      assert.deepEqual(writes, [
        { locked_until: '2026-09-01', confirm_unlock: true },
      ]);
      await persisted('2026-09-01');
      await lockForm
        .getByRole('button', { name: '清除關帳日 ' + ledger.name, exact: true })
        .click();
      await submit.click();
      await unlock.waitFor();
      await unlock
        .getByText('解鎖後，原關帳日 2026-09-01（含）以前的交易可再修改。', {
          exact: true,
        })
        .waitFor();
      await capture('unlock-clear', width, height, theme);
      response = page.waitForResponse(lockUrl);
      await page
        .getByRole('button', { name: '確認解鎖關帳', exact: true })
        .click();
      assert.equal((await response).status(), 200);
      await unlock.waitFor({ state: 'hidden' });
      assert.deepEqual(writes[1], { locked_until: null, confirm_unlock: true });
      await persisted(null);
      page.off('request', listener);
      await page.route(lockUrl, (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unavailable' }),
        }),
      );
      await dateField.fill('2026-09-30');
      await submit.click();
      await lockForm.getByRole('alert').waitFor();
      await capture('lock-error', width, height, theme);
      await persisted(null);
      await page.unroute(lockUrl);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(lockUrl, async (route) => {
        await gate;
        await route.continue();
      });
      await lockForm.getByRole('button', { name: '重試', exact: true }).click();
      assert.equal(await dateField.isDisabled(), true);
      await capture('lock-saving', width, height, theme);
      response = page.waitForResponse(lockUrl);
      // Route removal must follow the dependent refresh, not just PATCH headers.
      const retryRefresh = page.waitForResponse(
        (r) =>
          r.url() === 'https://localhost:18444/api/ledgers' &&
          r.request().method() === 'GET' &&
          r.status() === 200,
      );
      release();
      const retrySaved = await response;
      assert.equal(retrySaved.status(), 200);
      assert.equal(await retrySaved.finished(), null);
      const refreshed = await retryRefresh;
      assert.equal(await refreshed.finished(), null);
      assert.equal(
        (await refreshed.json()).find((r) => r.id === ledger.id).locked_until,
        '2026-09-30',
      );
      await page.unroute(lockUrl);
      await lockForm.getByRole('alert').waitFor({ state: 'hidden' });
      await persisted('2026-09-30');
      // Reset through the API with an explicit user confirmation for the next matrix combination.
      await lockForm
        .getByRole('button', { name: '清除關帳日 ' + ledger.name, exact: true })
        .click();
      await submit.click();
      response = page.waitForResponse(lockUrl);
      await page
        .getByRole('button', { name: '確認解鎖關帳', exact: true })
        .click();
      assert.equal((await response).status(), 200);
      await unlock.waitFor({ state: 'hidden' });
      await persisted(null);
    }
  console.log(
    'PASS admin matrix: 12 pages × 4 sizes × 2 themes, 16 editor/confirm + 40 lock states; grouped menu/back, desktop200px, no legacy tabs, focus/Esc, axe0/overflow0',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('主題', { exact: true }).selectOption('light');
  const field = (name) => page.getByRole('textbox', { name, exact: true });
  async function choose(name, value) {
    await field(name).click();
    await revealItemOption(page, value);
    await page.getByRole('option', { name: value, exact: true }).click();
  }
  async function save(label) {
    await page
      .getByRole('button', { name: '儲存' + label, exact: true })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForLoadState('networkidle');
  }
  // Items: create/edit, matching-kind parent, flags, archive/unarchive, name search.
  await page.goto('https://localhost:18444/admin/items');
  await page.getByRole('button', { name: '新增科目', exact: true }).click();
  await field('科目名稱').fill('合成管理資產');
  await choose('上層科目', '流動資產 (資產 / TWD)');
  await page.getByLabel('固定性', { exact: true }).check();
  await save('科目');
  await page
    .getByRole('button', { name: '編輯 合成管理資產', exact: true })
    .click();
  await page.getByRole('button', { name: '取消科目編輯', exact: true }).click();
  await page
    .getByRole('dialog', { name: '編輯科目', exact: true })
    .waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: '編輯 合成管理資產', exact: true })
    .click();
  await field('科目名稱').fill('合成管理資產改名');
  await save('科目');
  await page
    .getByRole('button', { name: '封存 合成管理資產改名', exact: true })
    .click();
  await page
    .getByRole('button', { name: '封存 合成管理資產改名', exact: true })
    .waitFor({ state: 'hidden' });
  await page.getByLabel('顯示封存科目', { exact: true }).check();
  await page
    .getByRole('button', { name: '取消封存 合成管理資產改名', exact: true })
    .click();
  await page
    .getByRole('button', { name: '封存 合成管理資產改名', exact: true })
    .waitFor();
  await page.waitForLoadState('networkidle');
  await field('搜尋科目').fill('合成管理資產改名');
  assert.equal(await page.getByRole('button', { name: /^編輯 / }).count(), 1);
  const item =
    await db`SELECT parent_id,fixed,archived FROM items WHERE ledger_id=${ledger.id} AND name='合成管理資產改名'`;
  assert.equal(item[0].parent_id, fixture.assets);
  assert.equal(item[0].fixed, true);
  assert.equal(item[0].archived, false);
  // All three named resources: CRUD + archive/unarchive + search + modal cancel/delete.
  for (const [route, label] of [
    ['payees', '收付人'],
    ['projects', '專案'],
    ['memo-templates', '常用摘要'],
  ]) {
    await page.goto('https://localhost:18444/admin/' + route);
    await page
      .getByRole('button', { name: '新增' + label, exact: true })
      .click();
    await field(label + '名稱').fill('合成新增' + label);
    if (route === 'memo-templates') await field('摘要文字').fill('合成原文');
    await save(label);
    await page
      .getByRole('button', {
        name: '編輯' + label + ' 合成新增' + label,
        exact: true,
      })
      .click();
    await page
      .getByRole('button', { name: '取消' + label + '編輯', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: '編輯' + label, exact: true })
      .waitFor({ state: 'hidden' });
    await page
      .getByRole('button', {
        name: '編輯' + label + ' 合成新增' + label,
        exact: true,
      })
      .click();
    await field(label + '名稱').fill('合成已改' + label);
    if (route === 'memo-templates') await field('摘要文字').fill('合成改文');
    await save(label);
    await page
      .getByRole('button', {
        name: '封存' + label + ' 合成已改' + label,
        exact: true,
      })
      .click();
    await page
      .getByRole('button', {
        name: '封存' + label + ' 合成已改' + label,
        exact: true,
      })
      .waitFor({ state: 'hidden' });
    await page.getByLabel('顯示封存' + label, { exact: true }).check();
    await page
      .getByRole('button', {
        name: '取消封存' + label + ' 合成已改' + label,
        exact: true,
      })
      .click();
    await page.waitForLoadState('networkidle');
    await field('搜尋' + label).fill('合成已改' + label);
    assert.equal(await page.getByRole('button', { name: /^編輯/ }).count(), 1);
    await page
      .getByRole('button', {
        name: '刪除' + label + ' 合成已改' + label,
        exact: true,
      })
      .click();
    await page
      .getByRole('button', { name: '確認刪除' + label, exact: true })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page
      .getByRole('button', {
        name: '刪除' + label + ' 合成已改' + label,
        exact: true,
      })
      .waitFor({ state: 'hidden' });
  }
  // Ledger name/currency CRUD remains separate from the explicit lock API; empty-only deletion preserved.
  await page.goto('https://localhost:18444/admin/ledgers');
  await page.getByRole('button', { name: '新增帳本', exact: true }).click();
  await field('帳本名稱').fill('合成新增待刪帳本');
  await save('帳本');
  await page.getByRole('button', { name: '管理目前帳本', exact: true }).click();
  await field('帳本名稱').fill('合成改名待刪帳本');
  await save('帳本');
  await page.getByRole('button', { name: '管理目前帳本', exact: true }).click();
  await page.getByRole('button', { name: '刪除空帳本', exact: true }).click();
  await page
    .getByRole('button', { name: '確認刪除空帳本', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '刪除空帳本', exact: true })
    .waitFor({ state: 'hidden' });
  await page
    .getByText('合成改名待刪帳本', { exact: true })
    .waitFor({ state: 'hidden' });
  console.log(
    'PASS management CRUD: ledger create/rename/empty delete; items create/rename/parent/flags/archive/unarchive/search; payees/projects/memos CRUD+archive/search',
  );
  // Real empty ledger and persisted lock state from seeded synthetic DB.
  await db`UPDATE ledgers SET locked_until='2026-09-30' WHERE id=${emptyLedger.id}`;
  await context.clearCookies();
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
  // Separate page init script overrides the original preference solely for this local synthetic ledger.
  await page.evaluate(
    ({ id }) => globalThis.localStorage.setItem('finmichi-ledger', id),
    { id: emptyLedger.id },
  );
  await page.goto('https://localhost:18444/admin/items');
  await page.getByText('尚無科目，請新增。', { exact: true }).waitFor();
  await capture('empty-state', 390, 844, 'light');
  await page.goto('https://localhost:18444/admin/ledgers');
  await page.getByText('關帳日：2026-09-30', { exact: true }).waitFor();
  assert.equal(
    await page
      .getByLabel('關帳日 ' + emptyLedger.name, { exact: true })
      .inputValue(),
    '2026-09-30',
  );
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/ledgers/*/items?*', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('https://localhost:18444/admin/items');
  await page.getByLabel('載入科目', { exact: true }).waitFor();
  await capture('loading-skeleton', 390, 844, 'light');
  release();
  await page.waitForLoadState('networkidle');
  await page.unroute('**/api/ledgers/*/items?*');
  await page.route('**/api/ledgers/*/items?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unavailable' }),
    }),
  );
  await page.goto('https://localhost:18444/admin/items');
  await page.getByRole('alert').waitFor();
  await capture('error-retry', 390, 844, 'light');
  await page.unroute('**/api/ledgers/*/items?*');
  await page.getByRole('button', { name: '重試', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  await page.getByText('尚無科目，請新增。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '新增科目', exact: true }).click();
  await field('科目名稱').fill('合成Toast科目');
  await save('科目');
  await page.getByRole('status').filter({ hasText: '已儲存科目' }).waitFor();
  await capture('success-toast', 390, 844, 'light');
  await page
    .locator('.entry-toast')
    .waitFor({ state: 'hidden', timeout: 6000 });
  // Lazy route/network proof uses fresh context so browser cache cannot hide eager loading.
  const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
  await fresh.addCookies([
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
  await fresh.addInitScript(
    ({ id }) => globalThis.localStorage.setItem('finmichi-ledger', id),
    { id: ledger.id },
  );
  const lazyPage = await fresh.newPage();
  const lazy = [];
  lazyPage.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith('.js'))
      lazy.push(new URL(r.url()).pathname);
  });
  await lazyPage.goto('https://localhost:18444/');
  await lazyPage.waitForLoadState('networkidle');
  const home = [...lazy];
  assert.equal(
    home.some((p) => /report-charts|entry-overlay|pats-|items-|admin-/.test(p)),
    false,
  );
  await lazyPage.goto('https://localhost:18444/admin/items');
  await lazyPage.waitForLoadState('networkidle');
  assert.ok(lazy.some((p) => /items-/.test(p)));
  await fresh.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const chunkFiles = (await readdir('apps/web/dist/assets'))
    .filter((n) => n.endsWith('.js'))
    .sort();
  const chunks = await Promise.all(
    chunkFiles.map(async (name) => {
      const data = await readFile('apps/web/dist/assets/' + name);
      return { name, bytes: data.length, gzipBytes: gzipSync(data).length };
    }),
  );
  await writeFile(
    output + '/bundles.json',
    JSON.stringify({ compression: 'gzip default level6', chunks }, null, 2) +
      '\n',
  );
  await writeFile(
    output + '/matrix.json',
    JSON.stringify(
      {
        results,
        errors,
        external,
        lazy: { home, visited: lazy },
        functional:
          'ledger/items/named CRUD + shared state and modal focus PASS',
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: ${results.length} admin/state viewport-theme cases and PNG; all CRUD, lock/unlock confirmation+cancel+clear+error+retry+busy, loading/empty/error+retry/toast, lazy route requests, axe0/overflow0/external0`,
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
