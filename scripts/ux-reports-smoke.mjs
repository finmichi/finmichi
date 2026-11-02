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
  transactionService,
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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-reports';
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
  await page.clock.setFixedTime(new Date('2026-10-31T04:00:00Z'));
  await page.addInitScript(() => {
    globalThis.chartText = [];
    const original = globalThis.CanvasRenderingContext2D.prototype.fillText;
    globalThis.CanvasRenderingContext2D.prototype.fillText = function (
      text,
      ...args
    ) {
      globalThis.chartText.push({ text, color: this.fillStyle });
      return original.call(this, text, ...args);
    };
  });
  const reportRequests = [];
  const errors = [],
    external = [],
    results = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (
      u.pathname.startsWith('/api/ledgers/') &&
      u.pathname.includes('/reports/')
    )
      reportRequests.push({
        path: u.pathname,
        params: Object.fromEntries(u.searchParams),
      });
    if (!['localhost', '127.0.0.1'].includes(u.hostname))
      external.push(u.origin);
  });
  const routes = ['balance-sheet', 'income-summary', 'category-statistics'];
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      for (const route of routes) {
        await page.goto(
          'https://localhost:18444/reports/' +
            route +
            (route === 'balance-sheet'
              ? '?as_of=2026-10-31'
              : route === 'income-summary'
                ? '?date_from=2026-08-01&date_to=2026-10-31&grain=month&owner_id=ignored'
                : '?date_from=2026-10-01&date_to=2026-10-31&kind=expense&non_operating=all&fixed=all&owner_id=ignored'),
        );
        await page.getByLabel('主題', { exact: true }).selectOption(theme);
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => globalThis.document.fonts.ready);
        assert.equal(
          await page.getByLabel('功能分頁', { exact: true }).count(),
          0,
        );
        assert.equal(
          await page
            .getByRole('textbox', { name: '報表種類', exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole('button', { name: '管理目前帳本', exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.locator('.report-nav a[aria-current="page"]').count(),
          1,
        );
        if (route === 'balance-sheet') {
          await page
            .getByRole('button', { name: '收合流動資產', exact: true })
            .waitFor();
          await page
            .locator('.report-amount-main')
            .getByText(width < 900 ? 'NT$ 43,880' : 'NT$ 43,880.00', {
              exact: true,
            })
            .last()
            .waitFor();
          await page.getByText(/恆等式驗算通過/).waitFor();
          await page
            .locator('.report-kpi')
            .filter({ hasText: '資產合計' })
            .getByText('NT$ 43,930', { exact: true })
            .waitFor();
          assert.equal(
            await page
              .getByRole('textbox', { name: '基準日', exact: true })
              .inputValue(),
            '2026-10-31',
          );
        } else {
          await page
            .getByRole('img', {
              name:
                route === 'income-summary' ? '收支彙總長條圖' : '分類圓餅圖',
              exact: true,
            })
            .locator('canvas')
            .waitFor();
          if (route === 'category-statistics')
            await page
              .getByRole('button', { name: '展開生活支出', exact: true })
              .click();
          const colors = await page.evaluate(() => ({
            text: globalThis.chartText,
            fg2: globalThis
              .getComputedStyle(globalThis.document.documentElement)
              .getPropertyValue('--fg-2')
              .trim(),
          }));
          const normalize = (s) => s.toLowerCase();
          assert.ok(
            colors.text.some(
              (t) => normalize(t.color) === normalize(colors.fg2),
            ),
            route + ' chart labels use current theme foreground',
          );
          assert.equal(
            (await page
              .locator('[data-chart-theme="' + theme + '"]')
              .count()) >= 1,
            true,
          );
        }
        assert.equal(
          await page.evaluate(
            () =>
              globalThis.document.documentElement.scrollWidth >
              globalThis.innerWidth,
          ),
          false,
        );
        assert.equal(
          await page
            .locator('.report-workspace')
            .evaluate((e) => e.scrollWidth > e.clientWidth),
          false,
        );
        if (width < 900) {
          assert.equal(await page.locator('.report-table:visible').count(), 0);
          assert.ok((await page.locator('.report-card:visible').count()) > 0);
        }
        const violations = (
          await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
        ).violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        }));
        const name = route + '-' + width + 'x' + height + '-' + theme;
        await page.getByLabel('主內容', { exact: true }).evaluate((el) => {
          for (let current = el; current; current = current.parentElement)
            current.scrollTop = 0;
        });
        await page.screenshot({
          path: output + '/' + name + '.png',
          animations: 'disabled',
        });
        if (route === 'category-statistics') {
          await page
            .getByRole('heading', { name: '科目分類明細', exact: true })
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: output + '/' + name + '-details.png',
            animations: 'disabled',
          });
        }
        results.push({
          route,
          width,
          height,
          theme,
          violations,
          horizontalOverflow: false,
        });
        await writeFile(
          output + '/matrix.json',
          JSON.stringify({ results, errors, external }, null, 2),
        );
        assert.deepEqual(violations, [], name);
      }
      console.log(
        JSON.stringify({
          width,
          height,
          theme,
          reports: 3,
          contrastViolations: 0,
        }),
      );
    }
  const field = (name) => page.getByRole('textbox', { name, exact: true });
  async function select(label, value) {
    await field(label).click();
    await revealItemOption(page, value);
    await page.getByRole('option', { name: value, exact: true }).click();
  }
  const urlParams = () => new URL(page.url()).searchParams;
  const assertField = async (label, value) =>
    assert.equal(await field(label).inputValue(), value, label);
  // Deep link → form → Enter/apply → canonical URL → reload/back/forward.
  await page.goto(
    'https://localhost:18444/reports/income-summary?date_from=2026-08-01&date_to=2026-10-31&grain=quarter&owner_id=ignored',
  );
  await page.waitForLoadState('networkidle');
  await assertField('收支起始日期', '2026-08-01');
  await assertField('收支結束日期', '2026-10-31');
  await assertField('收支粒度', '季');
  await field('收支起始日期').fill('2026-09-01');
  await field('收支起始日期').press('Enter');
  await page.waitForURL(
    (u) =>
      u.searchParams.get('date_from') === '2026-09-01' &&
      !u.searchParams.has('owner_id'),
  );
  await page.waitForLoadState('networkidle');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await assertField('收支起始日期', '2026-09-01');
  await assertField('收支粒度', '季');
  await select('收支粒度', '年');
  await page.getByRole('button', { name: '產生收支彙總', exact: true }).click();
  await page.waitForURL((u) => u.searchParams.get('grain') === 'year');
  await page.goBack();
  await page.waitForLoadState('networkidle');
  await assertField('收支粒度', '季');
  await page.goForward();
  await page.waitForLoadState('networkidle');
  await assertField('收支粒度', '年');
  assert.deepEqual([...urlParams().keys()].sort(), [
    'date_from',
    'date_to',
    'grain',
  ]);
  await page.goto(
    'https://localhost:18444/reports/category-statistics?date_from=2026-08-01&date_to=2026-10-31&kind=income&non_operating=non_operating&fixed=variable&owner_id=ignored',
  );
  await page.waitForLoadState('networkidle');
  await assertField('分類起始日期', '2026-08-01');
  await assertField('分類結束日期', '2026-10-31');
  await assertField('分類類別', '收入');
  await assertField('業外篩選', '僅業外');
  await assertField('固定性篩選', '僅非固定');
  await page.getByText('期間總額：NT$ 50.00', { exact: true }).waitFor();
  await field('分類起始日期').fill('2026-09-01');
  await field('分類起始日期').press('Enter');
  await page.waitForURL(
    (u) =>
      u.searchParams.get('date_from') === '2026-09-01' &&
      !u.searchParams.has('owner_id'),
  );
  await page.reload();
  await page.waitForLoadState('networkidle');
  await assertField('分類類別', '收入');
  await assertField('業外篩選', '僅業外');
  await assertField('固定性篩選', '僅非固定');
  await select('分類類別', '支出');
  await select('業外篩選', '全部');
  await select('固定性篩選', '全部');
  await page.getByRole('button', { name: '產生分類統計', exact: true }).click();
  await page.waitForURL((u) => u.searchParams.get('kind') === 'expense');
  await page.goBack();
  await page.waitForLoadState('networkidle');
  await assertField('分類類別', '收入');
  await assertField('業外篩選', '僅業外');
  await assertField('固定性篩選', '僅非固定');
  await page.goForward();
  await page.waitForLoadState('networkidle');
  await assertField('分類類別', '支出');
  await assertField('業外篩選', '全部');
  await assertField('固定性篩選', '全部');
  assert.deepEqual([...urlParams().keys()].sort(), [
    'date_from',
    'date_to',
    'fixed',
    'kind',
    'non_operating',
  ]);
  console.log(
    'PASS report URLs: income/category deep links, Enter, apply, reload, back/forward, enum filters, canonical URL allowlist',
  );
  const items = itemService(db),
    transactions = transactionService(db);
  const twdDebt = await items.create(actor, ledger.id, {
    name: '合成台幣信用卡',
    kind: 'liability',
    currency: 'TWD',
  });
  const usdDebt = await items.create(actor, ledger.id, {
    name: '合成美元信用卡',
    kind: 'liability',
    currency: 'USD',
  });
  const usdAsset = await items.create(actor, ledger.id, {
    name: '合成美元資產',
    kind: 'asset',
    currency: 'USD',
    parent_id: fixture.assets,
  });
  const leaf = await items.create(actor, ledger.id, {
    name: '合成單一葉科目',
    kind: 'expense',
    currency: 'TWD',
  });
  for (const entries of [
    [
      { item_id: fixture.cash, amount: '799' },
      { item_id: twdDebt.id, amount: '-799' },
    ],
    [
      { item_id: fixture.cash, amount: '3200' },
      { item_id: usdDebt.id, amount: '-100', exchange_rate: '32' },
    ],
    [
      { item_id: fixture.cash, amount: '-25600' },
      { item_id: usdAsset.id, amount: '800', exchange_rate: '32' },
    ],
    [
      { item_id: fixture.cash, amount: '-18000' },
      { item_id: leaf.id, amount: '18000' },
    ],
  ])
    await transactions.create(actor, ledger.id, {
      occurred_on: '2026-10-18',
      entries,
    });
  async function reviewShot(scenario, width, height, theme) {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => globalThis.document.fonts.ready);
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth,
      ),
      false,
    );
    assert.equal(
      await page
        .locator('.report-workspace')
        .evaluate((e) => e.scrollWidth > e.clientWidth),
      false,
    );
    const violations = (
      await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
    ).violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    }));
    await page
      .getByLabel('主內容', { exact: true })
      .evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({
      path:
        output +
        '/' +
        scenario +
        '-' +
        width +
        'x' +
        height +
        '-' +
        theme +
        '.png',
      animations: 'disabled',
    });
    results.push({
      scenario,
      width,
      height,
      theme,
      violations,
      horizontalOverflow: false,
    });
    assert.deepEqual(violations, [], scenario);
  }
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.goto(
        'https://localhost:18444/reports/balance-sheet?as_of=2026-10-31',
      );
      await page.getByLabel('主題', { exact: true }).selectOption(theme);
      await page.waitForLoadState('networkidle');
      const row = (name) =>
        page
          .locator(width < 900 ? '.report-card' : '.report-table tbody tr')
          .filter({ hasText: name });
      await page
        .getByRole('button', { name: '收合流動資產', exact: true })
        .waitFor();
      await row('合成美元資產')
        .getByText('USD 800.00', { exact: true })
        .waitFor();
      await row('合成美元信用卡')
        .getByText('USD 100.00', { exact: true })
        .waitFor();
      assert.equal(
        (
          await row('合成美元信用卡').locator('.report-amount-main').innerText()
        ).trim(),
        width < 900 ? 'NT$ 3,200' : 'NT$ 3,200.00',
      );
      await row('合成台幣信用卡').getByText('—', { exact: true }).waitFor();
      // P3 adds a distinct market-value column; assert each field, not duplicate text.
      const baseCard = row('合成台幣信用卡');
      const expectedCardAmount = width < 900 ? 'NT$ 799' : 'NT$ 799.00';
      assert.equal(
        (await baseCard.locator('.report-amount-main').innerText()).trim(),
        expectedCardAmount,
      );
      assert.equal(
        (
          await baseCard.locator('.market-item-value strong').innerText()
        ).trim(),
        expectedCardAmount,
      );
      assert.equal(
        (await page.locator('.report-balance-grid').innerText()).includes(
          '自身',
        ),
        false,
      );
      assert.equal(
        (await page.locator('.report-balance-grid').innerText()).includes(
          '子樹',
        ),
        false,
      );
      assert.ok(
        Number(
          await row('流動資產')
            .locator('.report-amount-main')
            .evaluate((e) => globalThis.getComputedStyle(e).fontWeight),
        ) >= 600,
      );
      assert.ok(
        (
          await row('合成美元信用卡')
            .locator('.report-money')
            .first()
            .getAttribute('title')
        ).includes('USD 100.00'),
      );
      await reviewShot('balance-natural', width, height, theme);
      await page.goto(
        'https://localhost:18444/reports/category-statistics?date_from=2026-10-01&date_to=2026-10-31&kind=expense&non_operating=all&fixed=all&owner_id=ignored',
      );
      await page.waitForLoadState('networkidle');
      const money = row('合成單一葉科目').locator('.report-money');
      await money.waitFor();
      assert.equal(await row('合成單一葉科目').locator('small').count(), 0);
      assert.equal(
        await money.innerText(),
        width < 900 ? 'NT$ 18,000' : 'NT$ 18,000.00',
      );
      assert.equal(
        await money.evaluate((el) => {
          const r = globalThis.document.createRange();
          r.selectNodeContents(el);
          return r.getClientRects().length;
        }),
        1,
        'amount stays on one line',
      );
      assert.equal(
        await money.evaluate((el) => {
          const range = globalThis.document.createRange();
          range.selectNodeContents(el);
          const text = range.getBoundingClientRect();
          const cell = el.closest('td,dd').getBoundingClientRect();
          return text.left >= cell.left - 1 && text.right <= cell.right + 1;
        }),
        true,
        'amount is not clipped',
      );
      if (width <= 1280) {
        const chart = await page.locator('.report-charts').boundingBox(),
          table = await page
            .locator('.report-category-grid .report-section')
            .boundingBox();
        assert.ok(
          chart.y + chart.height <= table.y + 1,
          'chart stacks above table when width insufficient',
        );
      }
      await reviewShot('category-nowrap', width, height, theme);
    }
  for (const req of reportRequests) {
    const keys = Object.keys(req.params).sort();
    const allowed = req.path.includes('income-summary')
      ? ['date_from', 'date_to', 'grain']
      : req.path.includes('category-statistics')
        ? ['date_from', 'date_to', 'fixed', 'kind', 'non_operating']
        : ['as_of'];
    assert.deepEqual(keys, allowed);
  }
  await writeFile(
    output + '/matrix.json',
    JSON.stringify({ results, errors, external, reportRequests }, null, 2),
  );
  console.log(
    'PASS report review: natural USD liability/asset, base dash, hidden own/subtree titles, initial root expansion/subtotals; 18000 nowrap/leaf no-own and 1280 stacking; API unknown fields0',
  );
  // Same-page theme switching must repaint existing chart text without losing filters.
  await page.getByLabel('主題', { exact: true }).selectOption('light');
  await page.locator('[data-chart-theme="light"]').waitFor();
  await page.getByLabel('主題', { exact: true }).selectOption('dark');
  await page.locator('[data-chart-theme="dark"]').waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    'PASS: 40 report viewport/theme cases, 48 screenshots; token-colored canvas text, cards/tree, deep links, no legacy tabs, no overflow, axe0, external0',
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
