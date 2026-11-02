// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  ledgerService,
  deletionLedgerTables,
} from '../packages/core/dist/index.js';
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
  throw new Error('Only a dedicated local synthetic DB is permitted');
const output = process.env.RESET_UI_OUTPUT_DIR ?? 'test-results/data-reset';
await mkdir(output, { recursive: true });
const issuer = `https://reset-ui-${Date.now()}.synthetic.invalid`,
  layouts = [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ].flatMap(([width, height]) =>
    ['light', 'dark'].map((theme) => [
      width,
      height,
      theme,
      theme === 'light' ? 'purge' : 'factory',
    ]),
  ),
  subjects = [...layouts.map((_, i) => 'reset-ui-' + i), 'stranger'];
let db, app, browser, provider;
try {
  db = connect(databaseUrl);
  await migrate(db);
  provider = await syntheticReauthProvider(issuer);
  const config = {
    databaseUrl,
    publicUrl: 'https://localhost:18444',
    issuer,
    clientId: 'synthetic',
    allowedSubjects: subjects,
    trustProxy: 0,
    version: 'ui-test',
    mockInternalUrl: provider.url,
    tlsKey: 'deploy/local/tls-key',
    tlsCert: 'deploy/local/tls-cert',
    allowFactoryReset: true,
  };
  app = await createApp(config, db);
  await app.listen({ host: '127.0.0.1', port: 18444 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {}),
    args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const sessions = sessionService(db, subjects),
    ls = ledgerService(db);
  const otherToken = await sessions.login(issuer, 'stranger'),
    otherActor = (await sessions.authenticate(otherToken)).id;
  const other = await ls.create(otherActor, { name: '合成他人不可刪帳本' });
  await seedDeletionLedger(db, otherActor, other.id);
  const otherBefore = [];
  for (const table of deletionLedgerTables)
    otherBefore.push(
      Number(
        (
          await db`SELECT count(*)::integer n FROM ${db(table)} WHERE ledger_id=${other.id}`
        )[0].n,
      ),
    );
  const results = [];
  let retainedCookie;
  for (const [index, [width, height, theme, mode]] of layouts.entries()) {
    const subject = subjects[index];
    provider.setSubject(subject);
    const token = await sessions.login(issuer, subject),
      actor = (await sessions.authenticate(token)).id;
    const ledger = await ls.create(actor, { name: '合成可刪除帳本' }),
      extra = await ls.create(actor, { name: '合成第二帳本' });
    await seedDeletionLedger(db, actor, ledger.id);
    await db`UPDATE ledgers SET locked_until='2026-10-31' WHERE id=${ledger.id}`;
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      reducedMotion: 'reduce',
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
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
    const title = mode === 'purge' ? '刪除帳本與全部資料' : '原廠重置',
      path = mode === 'purge' ? '/admin/ledgers' : '/admin/system';
    const open = async () =>
      page
        .getByRole('button', {
          name: title + (mode === 'purge' ? ' ' + ledger.name : ''),
          exact: true,
        })
        .click();
    await page.goto(config.publicUrl + path);
    await open();
    const dialog = page.getByRole('dialog', { name: title, exact: true }),
      confirm = dialog.getByRole('button', {
        name: '確認' + title,
        exact: true,
      });
    await dialog
      .getByText('請重新登入後再回到本頁預覽。', { exact: true })
      .waitFor();
    assert.equal(await confirm.isDisabled(), true);
    const reauthenticated = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/auth/callback' && r.status() === 302,
    );
    await dialog
      .getByRole('link', { name: '重新登入驗證身分', exact: true })
      .click();
    await reauthenticated;
    await page.waitForURL(config.publicUrl + path);
    await open();
    await dialog
      .getByText('已完成重新驗證，僅在 5 分鐘內有效。', { exact: true })
      .waitFor();
    assert.equal(provider.prompts.at(-1), 'login');
    await dialog
      .getByRole('button', { name: '預覽刪除範圍', exact: true })
      .click();
    await dialog.getByText(/關帳日：2026-10-31/).waitFor();
    assert.equal(await confirm.isDisabled(), true);
    await page.screenshot({
      path: `${output}/${width}-${theme}-preview.png`,
      fullPage: true,
    });
    const targets = mode === 'factory' ? [ledger, extra] : [ledger];
    for (const row of targets) {
      const pending = page.waitForEvent('download');
      await dialog
        .getByRole('button', {
          name: '下載刪除前備份 ' + row.name,
          exact: true,
        })
        .click();
      const download = await pending;
      await download.saveAs(`${output}/${width}-${theme}-${row.id}.json`);
      assert.equal(await confirm.isDisabled(), true);
    }
    const text = dialog.getByRole('textbox', {
      name: '請逐字輸入「' + (mode === 'purge' ? ledger.name : 'RESET') + '」',
      exact: true,
    });
    await text.fill('錯誤確認');
    await dialog
      .getByRole('checkbox', {
        name: '我已確認全部 JSON 備份可讀取，並了解這個動作無法復原',
        exact: true,
      })
      .check();
    assert.equal(await confirm.isDisabled(), true);
    await text.fill(mode === 'purge' ? ledger.name : 'RESET');
    assert.equal(await confirm.isEnabled(), true);
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    );
    assert.equal(overflow, false);
    const contrast = (
      await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
    ).violations;
    assert.deepEqual(contrast, []);
    await page.screenshot({
      path: `${output}/${width}-${theme}-confirm.png`,
      fullPage: true,
    });
    await confirm.click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .getByRole('status')
      .filter({
        hasText: mode === 'purge' ? '已刪除帳本與全部資料' : '已完成原廠重置',
      })
      .waitFor();
    for (const row of targets)
      for (const table of deletionLedgerTables)
        assert.equal(
          Number(
            (
              await db`SELECT count(*)::integer n FROM ${db(table)} WHERE ledger_id=${row.id}`
            )[0].n,
          ),
          0,
          table,
        );
    assert.equal((await ls.list(actor)).length, mode === 'purge' ? 1 : 0);
    for (const [i, table] of deletionLedgerTables.entries())
      assert.equal(
        Number(
          (
            await db`SELECT count(*)::integer n FROM ${db(table)} WHERE ledger_id=${other.id}`
          )[0].n,
        ),
        otherBefore[i],
      );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    retainedCookie = (await context.cookies()).find(
      (c) => c.name === 'session',
    ).value;
    await page.screenshot({
      path: `${output}/${width}-${theme}-success.png`,
      fullPage: true,
    });
    results.push({
      width,
      height,
      theme,
      mode,
      downloads: targets.length,
      overflow: 0,
      contrast: 0,
      errors: 0,
      external: 0,
      otherOwnerUnchanged: true,
      deletedLedgerTables: deletionLedgerTables.length,
    });
    await context.close();
  }
  await app.close();
  app = await createApp({ ...config, allowFactoryReset: false }, db);
  await app.listen({ host: '127.0.0.1', port: 18444 });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ignoreHTTPSErrors: true,
  });
  await context.addCookies([
    {
      name: 'session',
      value: retainedCookie,
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage();
  await page.goto(config.publicUrl + '/admin/system');
  await page.getByRole('heading', { name: '系統資訊', exact: true }).waitFor();
  await page.getByText('ui-test', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '原廠重置', exact: true }).count(),
    0,
  );
  const disabled = await context.request.post(
    config.publicUrl + '/api/factory-reset',
    { headers: { Origin: config.publicUrl }, data: { confirmation: 'RESET' } },
  );
  assert.equal(disabled.status(), 404);
  await page.screenshot({
    path: output + '/390-factory-disabled.png',
    fullPage: true,
  });
  await context.close();
  await writeFile(
    output + '/results.json',
    JSON.stringify(
      {
        states: results,
        factoryDisabledHidden: true,
        realOidcPrompts: provider.prompts,
        status: 'PASS',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      dataResetUi: 'PASS',
      states: results.length,
      overflow: 0,
      contrast: 0,
      factoryDisabledHidden: true,
    }),
  );
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (provider) await provider.close();
  if (db) await db.end();
}
