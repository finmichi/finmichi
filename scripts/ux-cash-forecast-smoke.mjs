// SPDX-License-Identifier: AGPL-3.0-only
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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-cash-forecast';
await mkdir(output, { recursive: true });
const issuer = `https://finance-ui-${Date.now()}.synthetic.invalid`;
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
  const emptyLedger = await ledgerService(db).create(actor, {
    name: '合成空帳本',
  });

  const now = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const next = new Date(now + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 2);
  await transactionService(db).create(actor, ledger.id, {
    occurred_on: next.toISOString().slice(0, 10),
    memo: '合成資金預估事件',
    entries: [
      { item_id: fixture.cash, amount: '-120' },
      { item_id: fixture.food, amount: '120' },
    ],
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
  // A finished network request does not mean a lazy module has evaluated.
  // Delay only this local test response to reproduce the original CI race.
  await page.route('**/assets/forecast-chart-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        'await new Promise(resolve => setTimeout(resolve, 1500));\n' +
        (await response.text()),
    });
  });

  const results = [],
    errors = [],
    external = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname))
      external.push(u.origin);
  });
  await context.addInitScript(
    ({ id }) => {
      if (!globalThis.localStorage.getItem('finmichi-ledger'))
        globalThis.localStorage.setItem('finmichi-ledger', id);
    },
    { id: ledger.id },
  );
  async function settle() {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => globalThis.document.fonts.ready);
  }
  async function capture(name, width, height, theme) {
    await page.evaluate(() => globalThis.document.fonts.ready);
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth ||
        [
          ...globalThis.document.querySelectorAll('.report-page,.report-card'),
        ].some((e) => e.scrollWidth > e.clientWidth + 1),
    );
    if (overflow)
      await page.screenshot({ path: output + '/overflow-debug.png' });
    assert.equal(overflow, false, name);
    const clipped = await page.evaluate(() =>
      [
        ...globalThis.document.querySelectorAll('.report-page,.report-card'),
      ].some((e) => {
        const b = e.getBoundingClientRect();
        return b.left < 0 || b.right > globalThis.innerWidth + 1;
      }),
    );
    if (clipped) {
      await page.screenshot({ path: output + '/clipped-debug.png' });
      await writeFile(
        output + '/clipped-debug.json',
        JSON.stringify(
          await page.evaluate(() =>
            [
              ...globalThis.document.querySelectorAll(
                '.report-page,.report-card,.report-toolbar,.mantine-MultiSelect-root',
              ),
            ].map((e) => ({
              class: e.className,
              box: e.getBoundingClientRect().toJSON(),
            })),
          ),
          null,
          2,
        ),
      );
    }
    assert.equal(clipped, false, name + ' container bounds');
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
        'https://localhost:18444/reports/flow?view=cash-forecast&horizon_days=30&threshold=999999999&unknown=must-not-send',
      );
      await page.getByLabel('主題', { exact: true }).selectOption(theme);
      await settle();
      await page
        .getByRole('heading', { name: '資金預估', exact: true })
        .waitFor();
      await page.getByRole('alert').filter({ hasText: '資金低於' }).waitFor();
      await page.getByText('合成資金預估事件', { exact: true }).waitFor();
      await page
        .locator('[data-chart-theme="' + theme + '"]')
        .waitFor({ state: 'visible' });
      assert.ok(
        await page.locator('[data-chart-theme="' + theme + '"]').count(),
      );
      const response = await page.request.get(
        'https://localhost:18444/api/ledgers/' +
          ledger.id +
          '/reports/cash-forecast?horizon_days=30',
      );
      assert.equal(response.status(), 200);
      const report = await response.json();
      assert.equal(report.days.length, 30);
      assert.equal(
        report.accounts.some((a) => a.name === '合成美元資產'),
        false,
      );
      const placeholder = await page
        .getByPlaceholder('預設全部符合條件的帳戶')
        .evaluate((input) => {
          const ref = globalThis.document.createElement('span');
          ref.style.color = 'var(--fg-3)';
          globalThis.document.body.append(ref);
          const expected = globalThis.getComputedStyle(ref).color;
          ref.remove();
          return {
            actual: globalThis.getComputedStyle(input, '::placeholder').color,
            expected,
          };
        });
      assert.equal(
        placeholder.actual,
        placeholder.expected,
        'placeholder follows AA fg-3 token',
      );
      if (width < 900) {
        const targets = await page
          .locator('.flow-views .mantine-SegmentedControl-label')
          .evaluateAll((labels) =>
            labels.map((l) => l.getBoundingClientRect().height),
          );
        assert.equal(targets.length, 3);
        assert.ok(
          targets.every((h) => h >= 44),
          'mobile flow view targets >=44px',
        );
      }
      await capture('forecast-data', width, height, theme);
      await page
        .getByRole('img', {
          name: '每日合計與各帳戶預估餘額折線圖',
          exact: true,
        })
        .scrollIntoViewIfNeeded();
      await capture('forecast-chart', width, height, theme);
      await page
        .getByText('合成資金預估事件', { exact: true })
        .scrollIntoViewIfNeeded();
      await capture('forecast-event-list', width, height, theme);
      await page.getByLabel('資金門檻', { exact: true }).fill('0');
      await page.getByLabel('資金門檻', { exact: true }).press('Enter');
      await settle();
      assert.ok(page.url().includes('threshold=0'));
      assert.equal(page.url().includes('unknown='), false);
      await page.reload();
      await settle();
      assert.equal(
        await page.getByLabel('資金門檻', { exact: true }).inputValue(),
        '0',
      );
      await capture('forecast-restored', width, height, theme);
      // Show selected-account URL restoration and server errors without altering financial data.
      await page.goto(
        'https://localhost:18444/reports/flow?view=cash-forecast&accounts=' +
          fixture.cash +
          '&horizon_days=60&threshold=0',
      );
      await settle();
      await page
        .getByRole('heading', { name: '每日預估餘額', exact: true })
        .waitFor();
      await capture('forecast-account', width, height, theme);
      await page.goto(
        'https://localhost:18444/reports/flow?view=cash-forecast&accounts=00000000-0000-4000-8000-000000000001',
      );
      await settle();
      await page.getByRole('button', { name: '重試', exact: true }).waitFor();
      await capture('forecast-error', width, height, theme);
      await page.evaluate(
        (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
        emptyLedger.id,
      );
      await page.goto(
        'https://localhost:18444/reports/flow?view=cash-forecast',
      );
      await settle();
      await page
        .getByRole('heading', { name: '沒有可預估的本位幣帳戶' })
        .waitFor();
      await capture('forecast-empty', width, height, theme);
      await page.evaluate(
        (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
        ledger.id,
      );
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const endpoint = /\/api\/ledgers\/[^/]+\/reports\/cash-forecast(?:\?|$)/;
      await page.route(endpoint, async (route) => {
        await held;
        await route.continue();
      });
      try {
        await page.goto(
          'https://localhost:18444/reports/flow?view=cash-forecast',
        );
        await page
          .getByRole('status', { name: '資金預估產生中', exact: true })
          .waitFor();
        await capture('forecast-loading', width, height, theme);
      } finally {
        release();
      }
      await settle();
      await page.unroute(endpoint);
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(
    output + '/matrix.json',
    JSON.stringify(
      {
        synthetic: true,
        states: results,
        browserErrors: errors,
        externalRequests: external,
      },
      null,
      2,
    ),
  );
  console.log(
    'Cash forecast matrix PASS',
    results.length,
    'screenshots; axe color-contrast 0; overflow 0; URL restore; readonly data',
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
