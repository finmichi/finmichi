// SPDX-License-Identifier: AGPL-3.0-only
import { revealItemOption } from './item-picker-test.mjs';
// Synthetic HTTP → browser → DB acceptance; never point at a real ledger DB.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  ledgerService,
  itemService,
  namedRecordService,
  recurringService,
  reminderService,
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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-recurring';
await mkdir(output, { recursive: true });
const issuer = `https://recurring-ui-${Date.now()}.synthetic.invalid`;
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
  await reminderService(db).saveSettings(actor, ledger.id, {
    market_enabled: false,
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
  await ledgerService(db).create(actor, {
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

  const service = recurringService(db);
  const ruleData = (name) => ({
    name,
    frequency: 'monthly',
    interval: 1,
    day_of_month: 31,
    start_on: '2026-01-01',
    end_on: '2026-02-28',
    template: {
      memo: '合成週期摘要',
      entries: [
        { item_id: fixture.cash, amount: '-1000.00' },
        { item_id: fixture.food, amount: '1000.00' },
      ],
    },
  });
  const rule = await service.save(actor, ledger.id, ruleData('合成每月房租'));
  await service.generate(actor, ledger.id, new Date('2026-03-01T00:00:00Z'));
  const [first] = await service.occurrences(actor, ledger.id);
  // A real failure state, not a mocked API response: temporarily close the occurrence date, attempt and then unlock.
  await ledgerService(db).setLock(actor, ledger.id, {
    locked_until: '2026-01-31',
  });
  await service.post(actor, ledger.id, first.id);
  await ledgerService(db).setLock(actor, ledger.id, {
    locked_until: null,
    confirm_unlock: true,
  });
  await db`INSERT INTO recurring_worker_runs(ledger_id,status,last_finished_at,next_retry_at,failure_count,error_code) VALUES (${ledger.id},'error','2026-10-18T00:06:00Z','2026-10-18T00:11:00Z',1,'worker_failed') ON CONFLICT(ledger_id) DO UPDATE SET status='error',last_finished_at=EXCLUDED.last_finished_at,next_retry_at=EXCLUDED.next_retry_at,failure_count=1,error_code='worker_failed'`;
  const field = (name) => page.getByRole('textbox', { name, exact: true });
  async function choose(name, value) {
    await field(name).click();
    await revealItemOption(page, value);
    await page.getByRole('option', { name: value, exact: true }).click();
  }
  async function settle() {
    await page.waitForLoadState('networkidle');
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
      await page.goto(
        'https://localhost:18444/admin/recurring?view=unknown&untrusted=1',
      );
      await page.getByLabel('主題', { exact: true }).selectOption(theme);
      await settle();
      await page
        .getByRole('heading', { name: '合成每月房租', exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel('功能分頁', { exact: true }).count(),
        0,
      );
      if (width < 900) {
        await page
          .getByRole('button', { name: '返回管理中心', exact: true })
          .click();
        await page.getByRole('link', { name: /週期交易/ }).click();
        await settle();
      }
      const card = page.locator('.admin-record').filter({
        has: page.getByRole('heading', { name: '合成每月房租', exact: true }),
      });
      assert.match(await card.textContent(), /1,000\.00/);
      assert.equal(
        (
          await card
            .getByRole('button', { name: '編輯 合成每月房租', exact: true })
            .textContent()
        ).trim(),
        '編輯',
      );

      assert.match(await card.textContent(), /合成現金|現金/);
      await page
        .getByText(
          /2026-10-18 08:06（台北）.*下次重試 2026-10-18 08:11（台北）/,
        )
        .waitFor();
      await capture('recurring-rules', width, height, theme);
      await page.getByRole('link', { name: /待確認（/ }).click();
      await settle();
      await page.getByText('入帳失敗：', { exact: false }).waitFor();
      await capture('recurring-pending-failed', width, height, theme);
      await page
        .getByRole('button', { name: '修改當期 合成每月房租', exact: true })
        .first()
        .click();
      await page
        .getByRole('dialog', { name: '修改當期', exact: true })
        .waitFor();
      await field('分錄 1 金額').waitFor();
      await capture('recurring-occurrence-editor', width, height, theme);
      await page.keyboard.press('Escape');
      await page
        .getByRole('dialog', { name: '修改當期', exact: true })
        .waitFor({ state: 'hidden' });
      await page.getByRole('link', { name: '規則清單', exact: true }).click();
      await settle();
      await page
        .getByRole('button', { name: '編輯 合成每月房租', exact: true })
        .click();
      await field('規則名稱').waitFor();
      await page
        .getByRole('dialog', { name: '編輯週期規則', exact: true })
        .getByText('每 1 個月的 31 日，月底不足取最後一天；下次 無後續日期', {
          exact: true,
        })
        .waitFor();
      await capture('recurring-rule-editor', width, height, theme);
      await field('規則名稱').fill('合成未儲存名稱');
      await page.keyboard.press('Escape');
      await page
        .getByRole('dialog', { name: '放棄未儲存內容', exact: true })
        .waitFor();
      await capture('recurring-dirty-confirm', width, height, theme);
      await page.getByRole('button', { name: '放棄修改', exact: true }).click();
      await page
        .getByRole('dialog', { name: '編輯週期規則', exact: true })
        .waitFor({ state: 'hidden' });
      await page
        .getByRole('button', { name: '刪除 合成每月房租', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: '刪除週期規則', exact: true })
        .waitFor();
      await capture('recurring-delete-confirm', width, height, theme);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.goto('https://localhost:18444/');
      await settle();
      await page
        .getByRole('region', { name: '待處理提醒' })
        .getByText(/^(?:● )?週期交易待確認$/)
        .first()
        .waitFor();
      assert.equal(
        await page
          .getByRole('region', { name: '待處理提醒' })
          .getByText(/^(?:● )?週期交易待確認$/)
          .count(),
        2,
      );
      await capture('recurring-overview-notice', width, height, theme);
    }
  console.log(
    'PASS recurring matrix: 7 states × 4 sizes × 2 themes; rule/draft/failed/confirm/notice, axe0/overflow0',
  );
  // Real 390px lifecycle: quick template creation, generation, edit current amount/date/memo, bulk post, skip, disable and delete.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://localhost:18444/admin/recurring');
  await page.getByLabel('主題', { exact: true }).selectOption('light');
  await settle();
  await page.getByRole('button', { name: '新增規則', exact: true }).click();
  await field('規則名稱').fill('合成快速週期');
  await page.getByLabel('開始日期', { exact: true }).fill('2026-01-01');
  await page.getByLabel('結束日期（選填）', { exact: true }).fill('2026-01-31');
  await field('來源金額 (TWD)').fill('88.88');
  await choose('來源科目', '流動資產 › 現金 (TWD)');
  await choose('目的科目', '生活支出 › 餐費 (TWD)');
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/recurring') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '儲存規則', exact: true }).click();
  assert.equal((await created).status(), 201);
  await page
    .getByRole('dialog', { name: '新增週期規則', exact: true })
    .waitFor({ state: 'hidden' });
  await settle();
  assert.ok(
    (await service.state(actor, ledger.id)).rules.some(
      (r) => r.name === '合成快速週期',
    ),
  );
  await page.getByRole('button', { name: '產生到今天', exact: true }).click();
  await settle();
  await page.getByRole('link', { name: /待確認（/ }).click();
  await settle();
  await page
    .getByRole('button', { name: '修改當期 合成每月房租', exact: true })
    .first()
    .click();
  await field('分錄 1 金額').fill('-99.99');
  await field('分錄 2 金額').fill('99.99');
  await page.getByLabel('交易日期', { exact: true }).fill('2026-03-01');
  await page.getByLabel('摘要', { exact: true }).fill('合成當期改值');
  await page.getByRole('button', { name: '儲存當期', exact: true }).click();
  await page
    .getByRole('dialog', { name: '修改當期', exact: true })
    .waitFor({ state: 'hidden' });
  await settle();
  assert.equal(
    (await service.state(actor, ledger.id)).rules.find((r) => r.id === rule.id)
      .template.memo,
    '合成週期摘要',
  );
  await page.getByLabel('全選待確認', { exact: true }).check();
  const posted = page.waitForResponse((r) =>
    r.url().endsWith('/recurring/post'),
  );
  await page.getByRole('button', { name: '確認所選入帳', exact: true }).click();
  assert.ok((await posted).ok());
  await settle();
  await page.getByText('沒有待確認的週期交易', { exact: true }).waitFor();
  const all = await service.occurrences(actor, ledger.id, { status: 'posted' });
  assert.equal(all.length, 3);
  const ids = all.map((o) => o.transaction_id);
  assert.equal(new Set(ids).size, 3);
  await page.goto('https://localhost:18444/admin/recurring');
  await settle();
  await page
    .getByRole('button', { name: '停用 合成快速週期', exact: true })
    .click();
  await settle();
  await page
    .getByRole('button', { name: '啟用 合成快速週期', exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: '刪除 合成快速週期', exact: true })
    .click();
  await page
    .getByRole('button', { name: '確認刪除週期規則', exact: true })
    .click();
  await settle();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(
    (
      await db`SELECT id FROM transactions WHERE ledger_id=${ledger.id} AND source_system='recurring'`
    ).length,
    3,
  );
  const extra = await service.save(actor, ledger.id, ruleData('合成略過'));
  await service.generate(actor, ledger.id, new Date('2026-03-01T00:00:00Z'));
  await page.goto('https://localhost:18444/admin/recurring?view=pending');
  await settle();
  const skipped = page.waitForResponse((r) => r.url().endsWith('/skip'));
  await page
    .getByRole('button', { name: '略過 合成略過', exact: true })
    .first()
    .click();
  assert.ok((await skipped).ok());
  await settle();
  assert.equal(
    (await service.occurrences(actor, ledger.id, { status: 'skipped' })).length,
    1,
  );
  await service.remove(actor, ledger.id, extra.id);
  // Shared loading/error/retry/empty states on new page.
  await page.route('**/api/ledgers/*/recurring', (r) =>
    r.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unavailable' }),
    }),
  );
  await page.goto('https://localhost:18444/admin/recurring');
  await page.getByRole('alert').waitFor();
  await capture('recurring-error', 390, 844, 'light');
  await page.unroute('**/api/ledgers/*/recurring');
  await page.getByRole('button', { name: '重試', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(
    output + '/matrix.json',
    JSON.stringify(
      {
        results,
        errors,
        external,
        functional:
          'quick template/current changes/bulk/skip/disable/delete-retains-posted PASS',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS recurring HTTP→browser→DB lifecycle, ${results.length} PNG; source IDs/no duplicates, unchanged template, deletion retains transactions`,
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
