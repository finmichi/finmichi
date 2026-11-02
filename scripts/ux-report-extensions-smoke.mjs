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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-report-extensions';
await mkdir(output, { recursive: true });
const issuer = `https://report-extensions-ui-${Date.now()}.synthetic.invalid`;
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
  const usd = await itemService(db).create(actor, ledger.id, {
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
  const empty = await ledgerService(db).create(actor, { name: '合成空帳本' });
  const emptyItem = await itemService(db).create(actor, empty.id, {
    name: '合成空科目',
    kind: 'asset',
    currency: 'TWD',
  });
  for (let i = 0; i < 103; i++)
    await transactionService(db).create(actor, ledger.id, {
      occurred_on: '2026-10-20',
      memo: '合成分頁 ' + i,
      entries: [
        { item_id: fixture.cash, amount: '-1' },
        { item_id: fixture.food, amount: '1' },
      ],
    });
  await transactionService(db).create(actor, ledger.id, {
    occurred_on: '2026-10-21',
    entries: [
      { item_id: usd.id, amount: '100', exchange_rate: '32' },
      { item_id: fixture.cash, amount: '-3200' },
    ],
  });

  const lossLedger = await ledgerService(db).create(actor, {
    name: '合成虧損帳本',
  });
  const lossCash = await itemService(db).create(actor, lossLedger.id, {
    name: '合成現金',
    kind: 'asset',
    currency: 'TWD',
  });
  const lossExpense = await itemService(db).create(actor, lossLedger.id, {
    name: '合成支出',
    kind: 'expense',
    currency: 'TWD',
  });
  await transactionService(db).create(actor, lossLedger.id, {
    occurred_on: '2026-10-01',
    entries: [
      { item_id: lossCash.id, amount: '-100' },
      { item_id: lossExpense.id, amount: '100' },
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

  async function settle() {
    await page.waitForLoadState('networkidle');
  }
  const range = 'date_from=2026-09-01&date_to=2026-12-31';
  const pages = [
    [
      'profit',
      'profit-loss',
      `/reports/profit-loss?${range}&grain=month&fixed=all&unknown=bad`,
      '損益表',
    ],
    [
      'flow',
      'net-worth-flow',
      `/reports/flow?${range}&grain=month&view=net-worth-flow&unknown=bad`,
      '淨值流量',
    ],
    [
      'account',
      'account-ledger',
      `/reports/flow?${range}&item_id=${fixture.assets}&view=account-ledger&unknown=bad`,
      '帳戶異動明細',
    ],
  ];
  const apiRequests = [];
  page.on('request', (r) => {
    if (
      new URL(r.url()).pathname.startsWith('/api/ledgers/') &&
      r.url().includes('/reports/')
    )
      apiRequests.push(r.url());
  });
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto('https://localhost:18444' + pages[0][2]);
      await page.getByLabel('主題', { exact: true }).selectOption(theme);
      await settle();
      for (const [name, apiName, url] of pages) {
        await page.goto('https://localhost:18444' + url);
        await settle();
        await page.getByText('產生時間：', { exact: false }).first().waitFor();
        if (name === 'profit') {
          if (width < 900) {
            await page
              .getByRole('textbox', { name: '損益表時段', exact: true })
              .click();
            await page
              .getByRole('option', { name: '2026-10', exact: true })
              .click();
          } else {
            const table = page.getByRole('table', {
              name: '損益表明細',
              exact: true,
            });
            assert.equal(await page.locator('.profit-report table').count(), 1);
            assert.equal(await page.locator('.profit-summary').count(), 0);
            assert.deepEqual(
              await table.locator('thead th').allTextContents(),
              ['科目', '2026-09', '2026-10', '2026-11', '2026-12', '合計'],
            );
            assert.deepEqual(
              await table.locator('tbody tr[class] > th').allTextContents(),
              [
                '營業收入',
                '營業支出',
                '其中固定性',
                '其中變動',
                '營業損益',
                '業外收入',
                '業外支出',
                '業外損益',
                '本期損益',
                '營業利益率',
              ],
            );
            assert.equal(
              await table
                .locator('thead th')
                .first()
                .evaluate((e) => globalThis.getComputedStyle(e).position),
              'sticky',
            );
            // Parent rollups must still expand/collapse inside the continuous table.
            const parent = table.getByRole('button', {
              name: '收合生活支出',
              exact: true,
            });
            assert.ok(
              ['600', '700'].includes(
                await parent
                  .locator('xpath=ancestor::tr')
                  .locator('td .report-money')
                  .first()
                  .evaluate(
                    (cell) => globalThis.getComputedStyle(cell).fontWeight,
                  ),
              ),
              'Parent rollup values must be bold',
            );
            const count = await table.locator('tbody tr').count();
            await parent.click();
            assert.ok((await table.locator('tbody tr').count()) < count);
            await table
              .getByRole('button', { name: '展開生活支出', exact: true })
              .click();
            assert.equal(await table.locator('tbody tr').count(), count);
            const scroll = page.getByLabel('損益表時段明細', { exact: true });
            assert.ok(
              await scroll.evaluate((e) => e.scrollWidth >= e.clientWidth),
            );
          }
          await page
            .getByRole('button', { name: '產生損益表', exact: true })
            .click();
          await settle();
          assert.ok(!page.url().includes('unknown='));
        }
        if (name === 'flow')
          assert.equal(
            await page
              .locator('[data-chart-theme]')
              .getAttribute('data-chart-theme'),
            theme,
          );
        if (name === 'account') {
          assert.equal(
            await page
              .locator('.account-entry,.account-table tbody tr')
              .count(),
            100,
          );
          const nextResponse = page.waitForResponse(
            (r) =>
              r.url().includes('/reports/account-ledger?') &&
              r.url().includes('cursor='),
          );
          await page
            .getByRole('button', { name: '載入更多分錄', exact: true })
            .click();
          const next = await nextResponse;
          assert.equal(next.status(), 200);
          assert.ok((await next.json()).items.length > 0);
          await page.waitForFunction(
            () =>
              globalThis.document.querySelectorAll(
                '.account-entry,.account-table tbody tr',
              ).length > 100,
          );
        }
        await page.getByLabel('主內容', { exact: true }).evaluate((el) => {
          for (let current = el; current; current = current.parentElement)
            current.scrollTop = 0;
        });
        await capture(name + '-data', width, height, theme);
        if (name === 'profit' && width >= 900) {
          // Force horizontal overflow, then check the real EdgeScroll control and sticky name column.
          await page.goto(
            'https://localhost:18444/reports/profit-loss?date_from=2026-01-01&date_to=2026-12-31&grain=month',
          );
          await settle();
          await page
            .getByText('產生時間：', { exact: false })
            .first()
            .waitFor();
          const viewport = page.getByLabel('損益表時段明細', { exact: true });
          const table = viewport.getByRole('table');
          const first = table.locator('thead th').first();
          const before = await first.boundingBox();
          assert.ok(
            await viewport.evaluate((e) => e.scrollWidth > e.clientWidth),
          );
          await page
            .locator('.profit-report .edge-scroll')
            .getByRole('button', { name: '向右捲動', exact: true })
            .click();
          await page.waitForFunction(
            () =>
              globalThis.document.querySelector('[aria-label="損益表時段明細"]')
                .scrollLeft > 0,
          );
          const after = await first.boundingBox();
          assert.ok(Math.abs(after.x - before.x) < 1);
          assert.ok(
            await first.evaluate((cell) => {
              const box = cell.getBoundingClientRect();
              return (
                globalThis.document
                  .elementFromPoint(
                    box.x + box.width / 2,
                    box.y + box.height / 2,
                  )
                  ?.closest('th') === cell
              );
            }),
            'The sticky 科目 header must paint above scrolling period headers',
          );
          const edges = await table
            .locator('tbody tr > :nth-child(2)')
            .evaluateAll((cells) =>
              cells.map((cell) => cell.getBoundingClientRect().right),
            );
          assert.ok(edges.every((edge) => Math.abs(edge - edges[0]) < 1));
          await capture('profit-wide', width, height, theme);
          await page.goto('https://localhost:18444' + url);
          await settle();
        }
        if (name === 'profit' && width < 900) {
          await page
            .getByRole('textbox', { name: '損益表粒度', exact: true })
            .click();
          await page.getByRole('option', { name: '年', exact: true }).click();
          const generated = page.waitForResponse(
            (r) =>
              r.url().includes('/reports/profit-loss?') &&
              new URL(r.url()).searchParams.get('grain') === 'year',
          );
          await page
            .getByRole('button', { name: '產生損益表', exact: true })
            .click();
          await generated;
          await settle();
          assert.equal(
            await page
              .getByRole('textbox', { name: '損益表時段', exact: true })
              .inputValue(),
            '合計',
          );
          assert.ok(
            !(await page.locator('.report-card').first().innerText()).includes(
              '—',
            ),
          );
        }

        const detail =
          name === 'account'
            ? page.locator('.account-entry,.account-table').first()
            : page.locator('.report-section').first();
        await detail.scrollIntoViewIfNeeded();
        await capture(name + '-details', width, height, theme);
        if (name === 'account') {
          const edit =
            width < 900
              ? page.locator('.account-entry').getByRole('button').first()
              : page
                  .locator('.account-table tbody')
                  .getByRole('button')
                  .first();
          await edit.click();
          await page
            .getByRole('dialog', { name: '修改交易', exact: true })
            .waitFor();
          await settle();
          await capture('account-edit', width, height, theme);
          await page
            .getByRole('button', { name: '關閉記帳', exact: true })
            .click();
          await settle();
        }
        const pattern = `**/api/ledgers/*/reports/${apiName}?*`;
        let resume;
        const pending = new Promise((resolve) => {
          resume = resolve;
        });
        await page.route(pattern, async (route) => {
          await pending;
          await route.continue();
        });
        await page.reload();
        await page
          .getByRole('status', {
            name:
              name === 'profit'
                ? '損益表產生中'
                : name === 'flow'
                  ? '淨值流量產生中'
                  : '帳戶異動載入中',
            exact: true,
          })
          .waitFor();
        await capture(name + '-loading', width, height, theme);
        resume();
        await settle();
        await page.unroute(pattern);
        await page.route(pattern, (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"error":"unavailable"}',
          }),
        );
        await page.reload();
        await page.getByRole('alert').waitFor();
        await capture(name + '-error', width, height, theme);
        await page.unroute(pattern);
        await page.getByRole('button', { name: '重試', exact: true }).click();
        await page.getByRole('alert').waitFor({ state: 'hidden' });
        await settle();
        await page.evaluate(
          (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
          empty.id,
        );
        await page.goto(
          'https://localhost:18444' + url.replace(fixture.assets, emptyItem.id),
        );
        await settle();
        await capture(name + '-empty', width, height, theme);
        if (name === 'profit') {
          await page.evaluate(
            (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
            lossLedger.id,
          );
          await page.goto('https://localhost:18444' + url);
          await settle();
          await page
            .getByRole(width < 900 ? 'heading' : 'rowheader', {
              name: '本期損益',
              exact: true,
            })
            .scrollIntoViewIfNeeded();
          assert.ok((await page.locator('.report-loss').count()) > 0);
          await capture('profit-loss-warning', width, height, theme);
        }
        if (name === 'flow') {
          await page.route(pattern, async (route) => {
            const original = await route.fetch();
            const body = await original.json();
            body.periods[0].is_balanced = false;
            body.periods[0].identity_difference = '0.01';
            await route.fulfill({ response: original, json: body });
          });
          await page.reload();
          await page.getByRole('alert').waitFor();
          await settle();
          await page.getByRole('alert').scrollIntoViewIfNeeded();
          await capture('flow-identity-warning', width, height, theme);
          await page.unroute(pattern);
        }
        await page.evaluate(
          (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
          ledger.id,
        );
      }
    }
  for (const [, apiName, url] of pages) {
    await page.goto('https://localhost:18444' + url);
    await settle();
    const downloading = page.waitForEvent('download');
    await page
      .getByRole('button', {
        name:
          apiName === 'account-ledger' ? '匯出帳戶異動 CSV' : '匯出報表 CSV',
        exact: true,
      })
      .click();
    const d = await downloading,
      csv = await (
        await import('node:fs/promises')
      ).readFile(await d.path(), 'utf8');
    assert.ok(csv.startsWith('\ufeff'));
    if (apiName === 'account-ledger') assert.ok(csv.split('\r\n').length > 102);
  }
  assert.ok(apiRequests.length > 0);
  assert.ok(
    apiRequests.every((url) => !new URL(url).searchParams.has('unknown')),
  );
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
          'three reports; URL allowlist; mobile period; load-more continuous; edit drawer; CSV BOM; empty/loading/error/retry; axe0/overflow0',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS extended report UX ${results.length} PNG; four sizes/two themes; CSV/edit/paging/URL; axe0/overflow0/external0`,
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
