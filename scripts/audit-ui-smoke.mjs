// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic localhost audit acceptance only; no real financial data.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import { sessionService, ledgerService } from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const address = new URL(databaseUrl);
if (
  !['127.0.0.1', 'localhost'].includes(address.hostname) ||
  !['/life_test', '/synthetic'].includes(address.pathname)
)
  throw new Error('Only a local synthetic test database is allowed');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/audit';
await mkdir(output, { recursive: true });
const issuer = `https://audit-ui-${Date.now()}.synthetic.invalid`;
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
  for (let i = 0; i < 32; i++)
    await ledgers.update(actor, ledger.id, { name: '合成操作紀錄帳本' });
  try {
    await ledgers.create(actor, { name: '合成操作紀錄帳本' });
  } catch {
    /* Expected duplicate creates error audit. */
  }
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
  await page.goto('https://localhost:18444/admin/audit');
  await page.getByRole('heading', { name: '稽核紀錄', exact: true }).waitFor();
  const query = async () => {
    const response = page.waitForResponse((r) =>
      r.url().includes('/api/audit-logs?'),
    );
    await page
      .getByRole('button', { name: '查詢操作紀錄', exact: true })
      .click();
    const r = await response;
    assert.equal(r.status(), 200);
    return r.json();
  };
  const first = await query();
  assert.equal(first.items.length, 25);
  assert.ok(first.next_cursor);
  const next = page.waitForResponse((r) =>
    r.url().includes('/api/audit-logs?'),
  );
  await page
    .getByRole('button', { name: '載入更多操作紀錄', exact: true })
    .click();
  const second = await (await next).json();
  assert.equal(
    new Set([...first.items, ...second.items].map((r) => r.id)).size,
    35,
  );
  await page.getByText('已載入 35 筆操作紀錄', { exact: true }).waitFor();
  await page.screenshot({
    path: output + '/audit-page-390.png',
    fullPage: true,
  });
  await page.getByRole('textbox', { name: '操作動作', exact: true }).click();
  await page
    .getByRole('option', { name: '帳本：修改／封存', exact: true })
    .click();
  let p = await query();
  assert.ok(p.items.every((r) => r.action === 'ledger.update'));
  assert.equal(p.items.length, 25);
  await page.getByRole('textbox', { name: '操作結果', exact: true }).click();
  await page.getByRole('option', { name: '失敗', exact: true }).click();
  p = await query();
  assert.equal(p.items.length, 0);
  await page.getByText('沒有符合條件的操作紀錄。', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '操作動作', exact: true }).click();
  await page.getByRole('option', { name: '帳本：新增', exact: true }).click();
  p = await query();
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].outcome, 'error');
  await page.screenshot({
    path: output + '/audit-error-filter-390.png',
    fullPage: true,
  });
  await page
    .getByLabel('操作起始時間', { exact: true })
    .fill('2031-01-01T00:00');
  p = await query();
  assert.equal(p.items.length, 0);
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    '390px audit: own records / cursor 25+10 no duplicates / action+outcome+time AND filters / empty state / cards / no horizontal overflow PASS',
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
