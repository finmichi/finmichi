// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic localhost only; no real financial data or tokens are written to evidence.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  ledgerService,
  patService,
  draftService,
  reminderService,
} from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
import { seedReport } from './report-fixture.mjs';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const u = new URL(databaseUrl);
if (
  !['127.0.0.1', 'localhost'].includes(u.hostname) ||
  !['/life_test', '/synthetic'].includes(u.pathname)
)
  throw new Error('Synthetic local DB required');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-mcp-drafts';
await mkdir(output, { recursive: true });
const issuer = `https://draft-ui-${Date.now()}.synthetic.invalid`,
  origin = 'https://localhost:18446';
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
      name: '合成 AI 草稿帳本',
    }),
    fixture = await seedReport(db, actor, ledger.id),
    pat = await patService(db).create(actor, {
      scope: 'draft',
      expires_in_days: 1,
    });
  const principal = await patService(db).authenticate(pat.token),
    drafts = draftService(db),
    day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  const input = {
    occurred_on: day,
    memo: '合成午餐草稿',
    entries: [
      { item_id: fixture.cash, amount: '-1300.00' },
      { item_id: fixture.food, amount: '1300.00' },
    ],
  };
  const first = await drafts.create(
    principal,
    ledger.id,
    input,
    '合成 AI 建議，請確認後入帳',
  );
  const modified = await drafts.create(
    principal,
    ledger.id,
    input,
    '合成修改驗收',
  );
  const rejected = await drafts.create(
    principal,
    ledger.id,
    input,
    '合成拒絕驗收',
  );
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
  await app.listen({ host: '127.0.0.1', port: 18446 });
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
    ({ id }) => globalThis.localStorage.setItem('finmichi-ledger', id),
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
  const endpoint = `**/api/ledgers/${ledger.id}/drafts?*`;
  const settle = async () => {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => globalThis.document.fonts.ready);
  };
  async function capture(name, w, h, theme) {
    await page.evaluate(() => globalThis.document.fonts.ready);
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    );
    assert.equal(overflow, false, name);
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
    const filename = `drafts-${name}-${w}x${h}-${theme}.png`;
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
  await page.goto(origin + '/admin/drafts');
  await settle();
  // Hold the catalog response: late draft hydration must never overwrite user input.
  let releaseCatalog, catalogStarted;
  const catalogGate = new Promise((resolve) => {
    releaseCatalog = resolve;
  });
  const catalogRequest = new Promise((resolve) => {
    catalogStarted = resolve;
  });
  await page.route('**/api/ledgers/*/memo_templates', async (route) => {
    catalogStarted();
    await catalogGate;
    await route.continue();
  });
  // Real edit/confirmation lifecycle: cancel retains edits, confirm posts one transaction.
  await page
    .getByRole('button', {
      name: `修改草稿 ${modified.id.slice(0, 8)}`,
      exact: true,
    })
    .click();
  const editor = page.getByRole('dialog', { name: '修改 AI 草稿' });
  await catalogRequest;
  await editor.getByLabel('摘要', { exact: true }).waitFor();
  assert.equal(
    await editor.getByLabel('摘要', { exact: true }).isDisabled(),
    true,
  );
  releaseCatalog();
  await page.waitForFunction(
    () => {
      const field = globalThis.document.querySelector('textarea');
      return field && !field.disabled && field.value === '合成午餐草稿';
    },
    null,
    { timeout: 15000 },
  );
  await page.unroute('**/api/ledgers/*/memo_templates');
  await settle();
  await editor.getByLabel('摘要', { exact: true }).fill('合成已修改草稿');
  await settle();
  await editor
    .getByRole('button', { name: '確認修改並核准', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '核准修改後的草稿' })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  assert.equal(
    await editor.getByLabel('摘要', { exact: true }).inputValue(),
    '合成已修改草稿',
  );
  assert.equal(
    (await drafts.get(actor, ledger.id, modified.id)).status,
    'pending',
  );
  await editor
    .getByRole('button', { name: '確認修改並核准', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '核准修改後的草稿' })
    .getByRole('button', { name: '核准並入帳', exact: true })
    .click();
  await editor.waitFor({ state: 'hidden' });
  await settle();
  const saved = await drafts.get(actor, ledger.id, modified.id);
  assert.equal(saved.status, 'approved');
  assert.equal(saved.payload.memo, '合成已修改草稿');
  assert.equal(
    (
      await db`SELECT count(*)::int n FROM transactions WHERE ledger_id=${ledger.id} AND source_system='mcp-draft' AND source_id=${modified.id}`
    )[0].n,
    1,
  );
  await page
    .getByRole('button', {
      name: `拒絕草稿 ${rejected.id.slice(0, 8)}`,
      exact: true,
    })
    .click();
  // Wait for the commit acknowledgement, even when a request is slow.
  let releaseReject, rejectStarted;
  const rejectGate = new Promise((resolve) => {
    releaseReject = resolve;
  });
  const rejectEntered = new Promise((resolve) => {
    rejectStarted = resolve;
  });
  const rejectPath = `**/api/ledgers/${ledger.id}/drafts/${rejected.id}/reject`;
  await page.route(rejectPath, async (route) => {
    rejectStarted();
    await rejectGate;
    await route.continue();
  });
  await page
    .getByRole('dialog', { name: '拒絕 AI 草稿' })
    .getByRole('button', { name: '確認拒絕草稿', exact: true })
    .click();
  await rejectEntered;
  assert.equal(
    (await drafts.get(actor, ledger.id, rejected.id)).status,
    'pending',
  );
  const committed = page.waitForResponse(
    (r) =>
      r.url() ===
        origin + `/api/ledgers/${ledger.id}/drafts/${rejected.id}/reject` &&
      r.request().method() === 'POST' &&
      r.status() === 204,
  );
  releaseReject();
  await committed;
  await page
    .getByRole('dialog', { name: '拒絕 AI 草稿' })
    .waitFor({ state: 'hidden' });
  await page.unroute(rejectPath);
  await settle();
  assert.equal(
    (await drafts.get(actor, ledger.id, rejected.id)).status,
    'rejected',
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
      await page.goto(origin + '/admin/drafts');
      await settle();
      await capture('data', w, h, theme);
      await page
        .getByRole('button', { name: '檢視', exact: true })
        .first()
        .click();
      await settle();
      await capture('preview', w, h, theme);
      await page
        .getByRole('button', { name: '關閉草稿檢視', exact: true })
        .click();
      await page
        .getByRole('button', {
          name: `修改草稿 ${first.id.slice(0, 8)}`,
          exact: true,
        })
        .click();
      await settle();
      await capture('editor', w, h, theme);
      await page.keyboard.press('Escape');
      await settle();
      await page
        .getByRole('button', {
          name: `核准草稿 ${first.id.slice(0, 8)}`,
          exact: true,
        })
        .click();
      await settle();
      await capture('confirm', w, h, theme);
      await page
        .getByRole('dialog', { name: '核准 AI 草稿' })
        .getByRole('button', { name: '取消', exact: true })
        .click();
      await page.route(endpoint, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [],
            next_cursor: null,
            pending_count: 0,
            max_base_amount: '100000',
          }),
        }),
      );
      await page.reload();
      await settle();
      await capture('empty', w, h, theme);
      await page.unroute(endpoint);
      await page.route(endpoint, (route) =>
        route.fulfill({
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
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(endpoint, async (route) => {
        await wait;
        await route.continue();
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page
        .getByRole('status', { name: '載入 AI 草稿', exact: true })
        .waitFor();
      await capture('loading', w, h, theme);
      release();
      await settle();
      await page.unroute(endpoint);
      await page.goto(origin + '/admin/tokens');
      await settle();
      const grant = page.getByLabel('允許 AI 建立待確認草稿', { exact: true });
      assert.equal(await grant.isChecked(), false);
      await grant.check();
      await page
        .getByText('AI 可建立待確認草稿，不能直接入帳', { exact: true })
        .waitFor();
      await capture('grant', w, h, theme);
      await reminderService(db).saveSettings(actor, ledger.id, {
        market_enabled: false,
      });
      await page.goto(origin + '/');
      await settle();
      await page
        .getByRole('region', { name: '待處理提醒' })
        .getByText(/^(?:● )?AI 草稿待審核$/)
        .waitFor();
      await capture('overview', w, h, theme);
    }
  // Dirty Esc guard keeps changes until explicitly discarded.
  await page.goto(origin + '/admin/drafts');
  await settle();
  await page
    .getByRole('button', {
      name: `修改草稿 ${first.id.slice(0, 8)}`,
      exact: true,
    })
    .click();
  await settle();
  await page
    .getByRole('dialog', { name: '修改 AI 草稿' })
    .getByLabel('摘要', { exact: true })
    .fill('合成未儲存');
  await page.keyboard.press('Escape');
  await page
    .getByRole('dialog', { name: '未儲存內容' })
    .getByRole('button', { name: '繼續編輯', exact: true })
    .click();
  assert.equal(
    await page
      .getByRole('dialog', { name: '修改 AI 草稿' })
      .getByLabel('摘要', { exact: true })
      .inputValue(),
    '合成未儲存',
  );
  await page.keyboard.press('Escape');
  await page
    .getByRole('dialog', { name: '未儲存內容' })
    .getByRole('button', { name: '捨棄變更', exact: true })
    .click();
  await page.goto(origin + '/admin/tokens');
  await settle();
  await page.getByLabel('允許 AI 建立待確認草稿', { exact: true }).check();
  await page.getByRole('button', { name: '建立草稿權杖', exact: true }).click();
  await page
    .getByRole('button', { name: '我已保存，隱藏權杖', exact: true })
    .click();
  await settle();
  const [createdPat] =
    await db`SELECT scope,mask_text FROM personal_access_tokens WHERE user_id=${actor} ORDER BY created_at DESC,id DESC LIMIT 1`;
  assert.equal(createdPat.scope, 'draft');
  assert.equal(createdPat.mask_text, true);
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify(globalThis.localStorage).includes('llp_'),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(states.length, 72);
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
    'MCP draft UX PASS 72 PNG; four sizes/two themes; edit/cancel/approve/reject/dirty guard; explicit grant; axe0/overflow0/external0',
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
