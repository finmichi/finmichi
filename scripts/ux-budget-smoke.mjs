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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-budget';
await mkdir(output, { recursive: true });
const issuer = `https://budget-ui-${Date.now()}.synthetic.invalid`;
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
        Array.from(
          globalThis.document.querySelectorAll('.admin-content,.report-page'),
        ).some((e) => e.scrollWidth > e.clientWidth + 1),
    );
    if (overflow) {
      await page.screenshot({ path: output + '/overflow-debug.png' });
      console.log(
        'OVERFLOW',
        width,
        await page.evaluate(() =>
          Array.from(globalThis.document.querySelectorAll('*'))
            .filter(
              (e) => e.scrollWidth > e.clientWidth + 2 && e.clientWidth > 0,
            )
            .map((e) => [e.tagName, e.className, e.clientWidth, e.scrollWidth])
            .slice(0, 35),
        ),
      );
    }
    assert.equal(overflow, false, name);
    const a = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .analyze();
    assert.deepEqual(a.violations, [], name);
    await page.screenshot({
      path: `${output}/${name}-${width}x${height}-${theme}.png`,
    });
    results.push({
      name,
      width,
      height,
      theme,
      horizontalOverflow: overflow,
      violations: a.violations,
    });
  }
  const b = budgetService(db);
  for (const [id, total] of [
    [fixture.expenses, '1200'],
    [fixture.food, '600'],
  ])
    await b.distribute(actor, ledger.id, { year: 2026, item_id: id, total });
  await b.save(actor, ledger.id, {
    year: 2026,
    item_id: fixture.travel,
    months: [{ month: 10, amount: '30' }],
  });
  async function settle() {
    await page.waitForLoadState('networkidle');
  }
  async function choose(label, value) {
    await page.getByRole('textbox', { name: label, exact: true }).click();
    await revealItemOption(page, value);
    await page.getByRole('option', { name: value, exact: true }).click();
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
      await page.goto('https://localhost:18444/admin/budgets');
      await page.getByLabel('主題', { exact: true }).selectOption(theme);
      await settle();
      if (width < 900) await choose('預算科目', '生活支出 › 餐費（支出）');
      await page
        .getByText('子科目也有預算，父科目合計會包含兩者', { exact: true })
        .waitFor();
      await capture('budget-editor', width, height, theme);
      if (width >= 900) {
        const scroll = page.getByLabel('預算年度表格', { exact: true });
        assert.ok(await scroll.evaluate((e) => e.scrollWidth > e.clientWidth));
        const before = await scroll.evaluate((e) => e.scrollLeft);
        await page
          .locator('.budget-grid')
          .getByRole('button', { name: '向右捲動', exact: true })
          .click();
        await settle();
        assert.ok((await scroll.evaluate((e) => e.scrollLeft)) > before);
      }
      await page
        .getByRole('button', { name: '清除預算 餐費', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: '清除預算', exact: true })
        .waitFor();
      await capture('budget-clear-confirm', width, height, theme);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      for (const grain of ['month', 'quarter', 'year']) {
        await page.goto(
          'https://localhost:18444/reports/budget-vs-actual?year=2026&grain=' +
            grain +
            '&kind=expense&non_operating=all&fixed=all&untrusted=1',
        );
        await settle();
        await page
          .getByRole('heading', { name: '預算 vs 實際', exact: true, level: 2 })
          .waitFor();
        if (grain === 'month') await choose('報表時段', '2026-10');
        if (grain === 'quarter') await choose('報表時段', '2026-Q4');
        await settle();
        await page.getByText('超支', { exact: true }).first().waitFor();
        await page.locator(`[data-chart-theme="${theme}"] canvas`).waitFor();
        const period = new URL(page.url()).searchParams.get('period');
        assert.equal(period, grain === 'year' ? '2026-01-01' : '2026-10-01');
        await page.reload();
        await settle();
        assert.equal(new URL(page.url()).searchParams.get('period'), period);
        if (grain === 'month') {
          // Reload restores the URL but resets scroll; capture the actual tree rows.
          await page
            .getByText('超支', { exact: true })
            .first()
            .evaluate((e) => {
              e.scrollIntoView({ block: 'center', behavior: 'instant' });
            });
          await capture('budget-report-tree', width, height, theme);
        }
        await page
          .getByLabel('主內容', { exact: true })
          .evaluate((e) => e.scrollTo({ top: 0, behavior: 'instant' }));
        await capture('budget-report-' + grain, width, height, theme);
      }
      await page.goto(
        'https://localhost:18444/reports/budget-vs-actual?year=2025&grain=year&kind=expense',
      );
      await settle();
      await page.getByText('沒有符合條件的科目。', { exact: true }).waitFor();
      await capture('budget-report-empty', width, height, theme);
    }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('https://localhost:18444/admin/budgets');
  await settle();
  await page
    .getByRole('textbox', { name: '薪資 1月預算', exact: true })
    .fill('1.23');
  await page
    .getByRole('textbox', { name: '餐費 1月預算', exact: true })
    .fill('2.34');
  const oneSaved = page.waitForResponse(
    (r) => r.url().endsWith('/budgets') && r.request().method() === 'PUT',
  );
  await page
    .getByRole('button', { name: '儲存預算 餐費', exact: true })
    .click();
  assert.ok((await oneSaved).ok());
  await settle();
  assert.equal(
    await page
      .getByRole('textbox', { name: '薪資 1月預算', exact: true })
      .inputValue(),
    '1.23',
  );
  await page.getByRole('link', { name: '總覽', exact: true }).click();
  await page
    .getByRole('dialog', { name: '捨棄未儲存預算？', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(page.url().includes('/admin/budgets'));
  await page
    .getByRole('textbox', { name: '預算年度', exact: true })
    .fill('2025');
  await page.getByRole('button', { name: '載入年度', exact: true }).click();
  await page
    .getByRole('dialog', { name: '捨棄未儲存預算？', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(
    await page
      .getByRole('textbox', { name: '薪資 1月預算', exact: true })
      .inputValue(),
    '1.23',
  );
  await page.getByRole('button', { name: '載入年度', exact: true }).click();
  await page.getByRole('button', { name: '捨棄並繼續', exact: true }).click();
  await settle();
  assert.equal(
    (await b.list(actor, ledger.id, { year: 2026 })).some(
      (v) => v.item_id === fixture.salary,
    ),
    false,
  );
  await page
    .getByRole('textbox', { name: '預算年度', exact: true })
    .fill('2026');
  await page.getByRole('button', { name: '載入年度', exact: true }).click();
  await settle();
  const formatted = page.getByRole('textbox', {
    name: '餐費 1月預算',
    exact: true,
  });
  // Wait for the requested year's rendered data, not an earlier networkidle state.
  await page.waitForFunction(
    (el) => el && !el.disabled && el.value === '2.34',
    await formatted.elementHandle(),
  );
  await formatted.fill('1234.56');
  await formatted.blur();
  assert.equal(await formatted.inputValue(), '1,234.56');
  await formatted.focus();
  assert.equal(await formatted.inputValue(), '1234.56');
  // Restore the clean fixture through save so later default-period navigation is unguarded.
  await formatted.fill('50.00');
  await page
    .getByRole('button', { name: '儲存預算 餐費', exact: true })
    .click();
  await settle();
  // A quiet network does not mean the lazy route's React effects have committed.
  // Delay renderer scheduling to exercise the CI race without relaxing URL assertions.
  await page.addInitScript(() => {
    if (
      globalThis.location.pathname === '/reports/budget-vs-actual' &&
      !globalThis.location.search
    ) {
      const nativePost = globalThis.MessagePort.prototype.postMessage;
      globalThis.MessagePort.prototype.postMessage = function (...args) {
        if (
          !new globalThis.URLSearchParams(globalThis.location.search).has(
            'period',
          )
        )
          globalThis.setTimeout(() => nativePost.apply(this, args), 900);
        else nativePost.apply(this, args);
      };
    }
  });
  await page.goto('https://localhost:18444/reports/budget-vs-actual');
  await settle();
  const current = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
  await page.waitForURL(
    (url) => url.searchParams.get('period') === current + '-01',
  );
  assert.equal(new URL(page.url()).searchParams.get('period'), current + '-01');
  // 390px real input → REST → DB, including small-cent December remainder.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://localhost:18444/admin/budgets');
  await settle();
  await choose('預算科目', '生活支出 › 餐費（支出）');
  await page
    .getByRole('textbox', { name: '餐費 年度總額', exact: true })
    .fill('0.06');
  const distributed = page.waitForResponse((r) =>
    r.url().endsWith('/budgets/distribute'),
  );
  await page
    .getByRole('button', { name: '平均分攤 餐費', exact: true })
    .click();
  assert.ok((await distributed).ok());
  await settle();
  const annual = await b.list(actor, ledger.id, { year: 2026 });
  assert.equal(
    annual.find((x) => x.item_id === fixture.food && x.month === 12).amount,
    '0.06',
  );
  assert.equal(
    annual.find((x) => x.item_id === fixture.food && x.month === 1).amount,
    '0.00',
  );
  await page
    .getByRole('textbox', { name: '餐費 10月預算', exact: true })
    .fill('100.00');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/budgets') && r.request().method() === 'PUT',
  );
  await page
    .getByRole('button', { name: '儲存預算 餐費', exact: true })
    .click();
  assert.ok((await saved).ok());
  await settle();
  assert.equal(
    (await b.list(actor, ledger.id, { year: 2026 })).find(
      (x) => x.item_id === fixture.food && x.month === 10,
    ).amount,
    '100.00',
  );
  await page.goto(
    'https://localhost:18444/reports/budget-vs-actual?year=2026&grain=month&kind=expense&untrusted=1',
  );
  await settle();
  await choose('預算報表粒度', '季');
  await choose('固定性篩選', '僅固定');
  await page
    .getByRole('textbox', { name: '報表年度', exact: true })
    .press('Enter');
  await settle();
  assert.ok(page.url().includes('grain=quarter'));
  assert.ok(page.url().includes('fixed=fixed'));
  assert.ok(!page.url().includes('untrusted'));
  const response = await page.request.get(
    'https://localhost:18444/api/ledgers/' +
      ledger.id +
      '/reports/budget-vs-actual?year=2026&grain=quarter&kind=expense&non_operating=all&fixed=fixed',
  );
  assert.equal(response.status(), 200);
  const report = await response.json();
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: '匯出預算報表 CSV', exact: true })
    .click();
  const d = await download;
  const csv = await (
    await import('node:fs/promises')
  ).readFile(await d.path(), 'utf8');
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes(report.totals.actual_total));
  assert.ok(csv.includes('全年合計'));
  await page.route('**/api/ledgers/*/budgets?*', (r) =>
    r.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"unavailable"}',
    }),
  );
  await page.goto('https://localhost:18444/admin/budgets');
  await page.getByRole('alert').waitFor();
  await capture('budget-editor-error', 390, 844, 'dark');
  await page.unroute('**/api/ledgers/*/budgets?*');
  await page.getByRole('button', { name: '重試', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  await settle();
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
          'grid arrows/current month save/annual0.06/URL Enter+allowlist/CSV/retry PASS',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS budget UX ${results.length} PNG; four sizes/two themes, editor+reports+empty+confirm, 390px input/distribute/URL/CSV/retry, axe0/overflow0/external0`,
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
