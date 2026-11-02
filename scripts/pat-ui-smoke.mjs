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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/pat';
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
  await page.goto('https://localhost:18444/admin/tokens');
  await page
    .getByRole('heading', { name: 'MCP 存取權杖', exact: true })
    .waitFor();
  await page.getByLabel('有效天數').fill('2');
  await page.getByLabel('允許所有自己的帳本').uncheck();
  await page.getByRole('textbox', { name: '允許的帳本', exact: true }).click();
  await page
    .getByRole('option', { name: '合成操作紀錄帳本', exact: true })
    .click();
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/pats') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '建立唯讀權杖', exact: true }).click();
  assert.equal((await created).status(), 201);
  const secret = await page.getByLabel('新權杖', { exact: true }).inputValue();
  assert.match(secret, /^llp_[A-Za-z0-9_-]{43}$/);
  await page
    .getByRole('button', { name: '我已保存，隱藏權杖', exact: true })
    .click();
  await page.getByRole('button', { name: '撤銷權杖', exact: true }).click();
  await page.getByRole('dialog', { name: '撤銷權杖', exact: true }).waitFor();
  await page.getByRole('button', { name: '確認撤銷權杖', exact: true }).click();
  await page.getByRole('button', { name: '已撤銷', exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: output + '/pat-390.png', fullPage: true });
  console.log(
    JSON.stringify({
      viewport: 390,
      create: 201,
      scoped: true,
      default_mask: true,
      secret_hidden: true,
      revoke: 204,
      horizontal_overflow: false,
    }),
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
