// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer';
// Synthetic HTTP → browser → DB acceptance; never point at a real ledger DB.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  backupPayloadSha256,
  backupService,
  ledgerService,
  recurringService,
  budgetService,
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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/backups';
await mkdir(output, { recursive: true });
const issuer = `https://backup-ui-${Date.now()}.synthetic.invalid`;
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
  const seeded = await seedReport(db, actor, ledger.id);
  await recurringService(db).save(actor, ledger.id, {
    name: '合成備份週期',
    frequency: 'monthly',
    day_of_month: 1,
    start_on: '2026-10-01',
    end_on: '2026-10-01',
    template: {
      entries: [
        { item_id: seeded.cash, amount: '-1000.37' },
        { item_id: seeded.food, amount: '1000.37' },
      ],
    },
  });
  await recurringService(db).generate(
    actor,
    ledger.id,
    new Date('2026-10-01T04:00:00Z'),
  );
  await budgetService(db).distribute(actor, ledger.id, {
    year: 2026,
    item_id: seeded.food,
    total: '12000.06',
  });
  await db`UPDATE ledgers SET locked_until='2026-10-31' WHERE id=${ledger.id}`;
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('https://localhost:18444/admin/backup');

  const pending = page.waitForEvent('download');
  await page
    .getByRole('button', { name: '下載 JSON 備份', exact: true })
    .click();
  const download = await pending;
  assert.match(download.suggestedFilename(), /^finmichi-.+-\d{8}-\d{6}\.json$/);
  await download.saveAs(output + '/synthetic-backup.json');
  const bytes = await readFile(output + '/synthetic-backup.json'),
    backup = JSON.parse(bytes.toString('utf8'));
  assert.equal(backup.format, 'finmichi');
  assert.equal(backup.schemaVersion, 9);
  assert.equal(backup.counts.recurring_rules, 1);
  assert.equal(backup.counts.recurring_occurrences, 1);
  assert.equal(backup.counts.budgets, 12);
  assert.equal(backup.payloadSha256, backupPayloadSha256(backup.tables));
  assert.equal(backup.tables.transactions.length, 6);
  assert.ok(!bytes.includes(Buffer.from('"owner_id"')));
  const file = page.locator('input[type=file]'),
    inspect = () =>
      page
        .getByRole('button', { name: '上傳並預覽 JSON', exact: true })
        .click();
  const results = [],
    external = [];
  page.on('request', (r) => {
    if (!['localhost', '127.0.0.1'].includes(new URL(r.url()).hostname))
      external.push(new URL(r.url()).origin);
  });
  async function capture(name, width, height, theme) {
    await page.evaluate(() => globalThis.document.fonts.ready);
    if (name.includes('preview'))
      await page
        .getByText('月預算：檔案 12 筆，將還原 12 筆', { exact: true })
        .scrollIntoViewIfNeeded();
    if (name.includes('checksum-error'))
      await page
        .getByRole('alert')
        .filter({ hasText: '備份校驗碼不相符' })
        .scrollIntoViewIfNeeded();

    const horizontalOverflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    );
    const violations = (
      await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
    ).violations;
    assert.equal(horizontalOverflow, false, name);
    assert.deepEqual(violations, [], name);
    await page.screenshot({
      path: `${output}/${name}-${width}x${height}-${theme}.png`,
      fullPage: true,
    });
    results.push({
      name,
      width,
      height,
      theme,
      horizontalOverflow,
      violations,
    });
  }
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto('https://localhost:18444/admin/backup');
      await page.getByLabel('主題', { exact: true }).selectOption(theme);
      await file.setInputFiles(output + '/synthetic-backup.json');
      await inspect();
      await page
        .getByText('週期當期：檔案 1 筆，將還原 1 筆', { exact: true })
        .waitFor();
      await page
        .getByText('月預算：檔案 12 筆，將還原 12 筆', { exact: true })
        .waitFor();
      await capture('p2-backup-full-preview', width, height, theme);
      await page
        .getByRole('checkbox', {
          name: '我已核對檔案與名稱，確認建立新帳本',
          exact: true,
        })
        .check();
      await page
        .getByRole('button', { name: '確認還原為新帳本', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: '還原為新帳本', exact: true })
        .waitFor();
      await capture('p2-backup-confirm', width, height, theme);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page
        .getByRole('textbox', { name: '還原模式', exact: true })
        .click();
      await page
        .getByRole('option', { name: '僅還原結構（structure）', exact: true })
        .click();
      await inspect();
      await page
        .getByText('週期當期：檔案 1 筆，將還原 0 筆', { exact: true })
        .waitFor();
      await capture('p2-backup-structure-preview', width, height, theme);
      const tampered = globalThis.structuredClone(backup);
      tampered.tables.budgets[0].amount = '11.00';
      await file.setInputFiles({
        name: 'synthetic-corrupt.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(tampered)),
      });
      await inspect();
      await page
        .getByRole('alert')
        .filter({ hasText: '備份校驗碼不相符' })
        .waitFor();
      await capture('p2-backup-checksum-error', width, height, theme);
    }
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  await writeFile(
    output + '/matrix.json',
    JSON.stringify({ results, errors, external }, null, 2) + '\n',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://localhost:18444/admin/backup');
  await page.getByLabel('主題', { exact: true }).selectOption('light');
  await file.setInputFiles(output + '/synthetic-backup.json');
  await inspect();
  await page.getByText('新帳本關帳日：2026-10-31', { exact: true }).waitFor();
  const name = page.getByRole('textbox', { name: '新帳本名稱', exact: true });
  await name.fill('合成手機完整還原');
  assert.equal(
    await page
      .getByRole('button', { name: '確認還原為新帳本', exact: true })
      .isDisabled(),
    true,
  );
  await inspect();
  await page.getByText('新帳本：合成手機完整還原', { exact: true }).waitFor();
  await page.screenshot({
    path: output + '/json-preview-390.png',
    fullPage: true,
  });
  async function confirm(label) {
    await page
      .getByRole('checkbox', {
        name: '我已核對檔案與名稱，確認建立新帳本',
        exact: true,
      })
      .check();
    await page
      .getByRole('button', { name: '確認還原為新帳本', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: '還原為新帳本', exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: '建立還原帳本', exact: true })
      .click();
    await page
      .getByRole('status')
      .filter({ hasText: `已還原為新帳本「${label}」，原帳本保留。` })
      .waitFor();
  }
  await confirm('合成手機完整還原');
  await page.screenshot({
    path: output + '/json-restored-390.png',
    fullPage: true,
  });
  const [full] =
    await db`SELECT id FROM ledgers WHERE owner_id=${actor} AND name='合成手機完整還原'`;
  const restored = await backupService(db).download(actor, full.id);
  assert.deepEqual(restored.counts, backup.counts);
  assert.equal(restored.ledger.locked_until, '2026-10-31');
  assert.equal(restored.counts.recurring_occurrences, 1);
  assert.equal(restored.counts.budgets, 12);
  assert.equal(
    (
      await db`SELECT count(*)::integer AS n FROM ledgers WHERE id=${ledger.id}`
    )[0].n,
    1,
  );
  await page.getByRole('button', { name: '開啟還原帳本', exact: true }).click();
  await page.getByRole('button', { name: '切換帳本', exact: true }).waitFor();
  await page.waitForFunction(() =>
    globalThis.document
      .querySelector('[aria-label="切換帳本"]')
      ?.textContent?.includes('合成手機完整還原'),
  );
  assert.match(
    await page
      .getByRole('button', { name: '切換帳本', exact: true })
      .textContent(),
    /合成手機完整還原/,
  );
  await page
    .locator('input[type=file]')
    .setInputFiles(output + '/synthetic-backup.json');
  await page.getByRole('textbox', { name: '還原模式', exact: true }).click();
  await page
    .getByRole('option', { name: '僅還原結構（structure）', exact: true })
    .click();
  await inspect();
  await page.getByText('新帳本關帳日：未設定', { exact: true }).waitFor();
  await page
    .getByText('交易：檔案 6 筆，將還原 0 筆', { exact: true })
    .waitFor();
  await page
    .getByRole('textbox', { name: '新帳本名稱', exact: true })
    .fill('合成手機結構還原');
  await inspect();
  await page.getByText('新帳本：合成手機結構還原', { exact: true }).waitFor();
  await page.screenshot({
    path: output + '/json-structure-390.png',
    fullPage: true,
  });
  await confirm('合成手機結構還原');
  const [structure] =
    await db`SELECT id,locked_until FROM ledgers WHERE owner_id=${actor} AND name='合成手機結構還原'`;
  assert.equal(structure.locked_until, null);
  const structureBackup = await backupService(db).download(actor, structure.id);
  assert.equal(structureBackup.counts.recurring_occurrences, 0);
  assert.equal(structureBackup.counts.budgets, 12);
  assert.equal(structureBackup.tables.recurring_rules[0].active, false);
  assert.equal(structureBackup.tables.recurring_rules[0].next_on, '2026-10-01');
  assert.equal(
    (
      await db`SELECT count(*)::integer AS n FROM transactions WHERE ledger_id=${structure.id}`
    )[0].n,
    0,
  );
  const bad = globalThis.structuredClone(backup);
  bad.tables.transaction_entries[0].amount = '999.000000';
  await page.locator('input[type=file]').setInputFiles({
    name: 'synthetic-tampered.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bad)),
  });
  await inspect();
  await page
    .getByRole('alert')
    .filter({ hasText: '備份校驗碼不相符' })
    .waitFor();
  await page.screenshot({
    path: output + '/json-checksum-error-390.png',
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    '390px JSON backup: download / upload preview / name change requires re-preview / full+structure confirm / new owner ledger / original retained / checksum rejection / no overflow PASS',
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
