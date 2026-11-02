// SPDX-License-Identifier: AGPL-3.0-only
// Regression for the main8c scroll race: delay renderer scheduling, never relax equality/timeout.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  ledgerService,
  itemService,
  transactionService,
} from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const u = new URL(databaseUrl);
if (
  !['127.0.0.1', 'localhost'].includes(u.hostname) ||
  !['/synthetic', '/life_test'].includes(u.pathname)
)
  throw new Error('Local synthetic DB only');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-entry-scroll';
await mkdir(output, { recursive: true });
const issuer = `https://scroll-${Date.now()}.synthetic.invalid`,
  origin = 'https://localhost:18452';
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
try {
  discovery.listen(0, '127.0.0.1');
  await once(discovery, 'listening');
  db = connect(databaseUrl);
  await migrate(db);
  const session = sessionService(db, ['owner']),
    token = await session.login(issuer, 'owner'),
    actor = (await session.authenticate(token)).id,
    l = await ledgerService(db).create(actor, { name: '合成捲動競態驗收' }),
    items = itemService(db),
    tx = transactionService(db);
  const cash = await items.create(actor, l.id, {
      name: '合成現金',
      kind: 'asset',
      currency: 'TWD',
    }),
    expense = await items.create(actor, l.id, {
      name: '合成費用',
      kind: 'expense',
      currency: 'TWD',
    });
  for (let i = 0; i < 35; i++)
    await tx.create(actor, l.id, {
      occurred_on: '2026-10-17',
      memo: '合成捲動交易' + i,
      entries: [
        { item_id: cash.id, amount: '-1' },
        { item_id: expense.id, amount: '1' },
      ],
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
  await app.listen({ host: '127.0.0.1', port: 18452 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {}),
    args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 360, height: 780 },
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
    globalThis.localStorage.setItem('finmichi-ledger', id);
    globalThis.localStorage.setItem('finmichi-theme', 'dark');
  }, l.id);
  await context.addInitScript(() => {
    globalThis.__scrollProbe = { expected: null, events: [] };
    const state = globalThis.__scrollProbe;
    const record = (event) => {
      const el = globalThis.document.querySelector('[aria-label="主內容"]');
      if (el && state.expected !== null) {
        state.events.push({
          event,
          ms: globalThis.performance.now(),
          top: el.scrollTop,
          height: el.scrollHeight,
          client: el.clientHeight,
        });
        if (state.events.length > 1000) state.events.shift();
      }
    };
    const nativePost = globalThis.MessagePort.prototype.postMessage;
    globalThis.MessagePort.prototype.postMessage = function (...args) {
      if (state.expected !== null)
        globalThis.setTimeout(() => nativePost.apply(this, args), 25);
      else nativePost.apply(this, args);
    };
    globalThis.addEventListener(
      'scroll',
      (e) => {
        if (e.target?.getAttribute?.('aria-label') === '主內容')
          record('scroll');
      },
      true,
    );
    const observer = new globalThis.MutationObserver(() => record('mutation'));
    globalThis.addEventListener('DOMContentLoaded', () =>
      observer.observe(globalThis.document.body, {
        subtree: true,
        childList: true,
      }),
    );
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const cdp = await context.newCDPSession(page),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const results = [];
  for (const rate of [1, 4, 8])
    for (let trial = 0; trial < 3; trial++) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      await page.goto(origin + '/transactions?keyword=合成');
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => globalThis.document.fonts.ready);
      await page.getByRole('button', { name: '載入更多', exact: true }).click();
      await page.getByText('已載入 35／35 筆', { exact: true }).waitFor();
      await page
        .getByRole('button', { name: '合成捲動交易0', exact: true })
        .click();
      await page.locator('.entry-preview').waitFor();
      const expected = await page
        .getByLabel('主內容', { exact: true })
        .evaluate((el) => el.scrollTop);
      assert.ok(expected > 0);
      await page.evaluate((v) => {
        globalThis.__scrollProbe.expected = v;
        globalThis.__scrollProbe.events = [];
      }, expected);
      await page
        .getByRole('textbox', { name: /^摘要/ })
        .fill('合成捲動交易0 已修改');
      await page.locator('.entry-preview').waitFor();
      await page.getByRole('button', { name: '儲存交易', exact: true }).click();
      await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
      await page
        .getByRole('button', { name: '合成捲動交易0 已修改', exact: true })
        .waitFor();
      await page.getByText('已載入 35／35 筆', { exact: true }).waitFor();
      try {
        await page.waitForFunction(
          (v) =>
            globalThis.document.querySelector('[aria-label="主內容"]')
              .scrollTop === v,
          expected,
        );
      } catch (e) {
        await writeFile(
          output + '/failure.json',
          JSON.stringify(
            await page.evaluate(() => globalThis.__scrollProbe),
            null,
            2,
          ),
        );
        await page.screenshot({ path: output + '/failure.png' });
        throw e;
      }
      const result = await page.evaluate(() => globalThis.__scrollProbe);
      results.push({ rate, trial, ...result });
      const [r] =
        await db`SELECT id FROM transactions WHERE ledger_id=${l.id} AND memo='合成捲動交易0 已修改'`;
      await tx.update(actor, l.id, r.id, { memo: '合成捲動交易0' });
    }
  assert.deepEqual(errors, []);
  assert.equal(results.length, 9);
  await writeFile(
    output + '/results.json',
    JSON.stringify(
      {
        synthetic: true,
        scheduler_delay_ms: 25,
        timeout_ms: 15000,
        cases: results,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'Entry scroll regression PASS 9 controlled cases; CPU1/4/8; scheduler25ms; exact equality and original15000ms timeout',
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
