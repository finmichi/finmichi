// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import { sessionService, ledgerService } from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
import { seedDeletionLedger } from './data-reset-fixture.mjs';
import { syntheticReauthProvider } from './data-reset-oidc.mjs';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const address = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1'].includes(address.hostname) ||
  !['/life_test', '/synthetic'].includes(address.pathname)
)
  throw new Error('Dedicated local synthetic database required');
const output =
  process.env.MANAGED_UI_OUTPUT_DIR ?? 'test-results/managed-transactions';
await mkdir(output, { recursive: true });
let db, app, browser, provider;
try {
  db = connect(databaseUrl);
  await migrate(db);
  const issuer = `https://managed-ui-${Date.now()}.synthetic.invalid`;
  provider = await syntheticReauthProvider(issuer);
  app = await createApp(
    {
      databaseUrl,
      publicUrl: 'https://localhost:18444',
      issuer,
      clientId: 'synthetic',
      mockInternalUrl: provider.url,
      allowedSubjects: ['owner'],
      trustProxy: 0,
      version: 'synthetic',
      tlsKey: 'deploy/local/tls-key',
      tlsCert: 'deploy/local/tls-cert',
    },
    db,
  );
  await app.listen({ host: '127.0.0.1', port: 18444 });
  const sessions = sessionService(db, ['owner']);
  const token = await sessions.login(issuer, 'owner'),
    actor = (await sessions.authenticate(token)).id;
  const ledger = await ledgerService(db).create(actor, {
    name: '合成受管理交易',
  });
  const seeded = await seedDeletionLedger(db, actor, ledger.id);
  const before =
    await db`SELECT to_jsonb(t) row FROM transactions t WHERE ledger_id=${ledger.id} ORDER BY id`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {}),
    args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const results = [];
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        ignoreHTTPSErrors: true,
        reducedMotion: 'reduce',
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
      const errors = [],
        external = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (
          ['http:', 'https:'].includes(u.protocol) &&
          !['localhost', '127.0.0.1'].includes(u.hostname)
        )
          external.push(u.origin);
      });
      const query = '/transactions?date_from=2026-01-01&date_to=2026-12-31';
      for (const [kind, id, transaction, field, value] of [
        [
          '股利',
          seeded.dividend.id,
          seeded.dividend.transaction_id,
          '參與股數',
          '10',
        ],
        [
          '定存',
          seeded.deposit.id,
          seeded.posting.transaction_id,
          '銀行',
          '合成銀行',
        ],
      ]) {
        await page.goto('https://localhost:18444' + query);
        const listLink = page.getByRole('link', {
          name: `由${kind}管理 · 前往編輯`,
          exact: true,
        });
        await listLink.waitFor();
        assert.ok((await listLink.getAttribute('href')).includes(id));
        await listLink.click();
        const editor = page.getByRole('dialog', {
          name: '編輯' + kind,
          exact: true,
        });
        await editor.waitFor();
        assert.equal(
          await editor
            .getByRole('textbox', { name: field, exact: true })
            .inputValue(),
          value,
        );
        assert.equal(
          await page.evaluate(
            () =>
              globalThis.document.documentElement.scrollWidth >
              globalThis.innerWidth,
          ),
          false,
        );
        assert.deepEqual(
          (
            await new AxeBuilder({ page })
              .withRules(['color-contrast'])
              .analyze()
          ).violations,
          [],
        );
        await page.screenshot({
          path: `${output}/${width}-${theme}-${kind}-linked-editor.png`,
          fullPage: true,
        });
        await editor
          .getByRole('button', { name: '關閉編輯', exact: true })
          .click();
        await editor.waitFor({ state: 'hidden' });
        assert.equal(
          new URL(page.url()).searchParams.has(
            kind === '股利' ? 'dividend_id' : 'deposit_id',
          ),
          false,
        );
        // A saved editor URL must resolve even when the dividend is outside the
        // currently visible report dates; the transaction drawer also directs here.
        await page.goto(
          'https://localhost:18444' + query + '&entry=' + transaction,
        );
        const drawerLink = page
          .getByRole('link', { name: `由${kind}管理 · 前往編輯`, exact: true })
          .last();
        await drawerLink.waitFor();
        await drawerLink.click();
        await editor.waitFor();
        assert.equal(
          await editor
            .getByRole('textbox', { name: field, exact: true })
            .inputValue(),
          value,
        );
        await editor
          .getByRole('button', { name: '關閉編輯', exact: true })
          .click();
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      results.push({
        width,
        height,
        theme,
        listLinks: 2,
        drawerLinks: 2,
        editorsVerified: 4,
        contrast: 0,
        overflow: 0,
        external: 0,
      });
      await context.close();
    }
  assert.deepEqual(
    await db`SELECT to_jsonb(t) row FROM transactions t WHERE ledger_id=${ledger.id} ORDER BY id`,
    before,
  );
  await writeFile(
    `${output}/results.json`,
    JSON.stringify(
      {
        managedTransactions: 'PASS',
        transactionsUnchanged: true,
        states: results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      managedTransactions: 'PASS',
      states: results.length,
      transactionsUnchanged: true,
    }),
  );
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (provider) await provider.close();
  if (db) await db.end();
}
