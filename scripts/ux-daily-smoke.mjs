// SPDX-License-Identifier: AGPL-3.0-only
import { parse } from 'csv-parse/sync';
import AxeBuilder from '@axe-core/playwright';
import { writeFile, readFile } from 'node:fs/promises';
// Synthetic localhost audit acceptance only; no real financial data.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
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
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const address = new URL(databaseUrl);
if (
  !['127.0.0.1', 'localhost'].includes(address.hostname) ||
  !['/life_test', '/synthetic'].includes(address.pathname)
)
  throw new Error('Only a local synthetic test database is allowed');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-daily';
await mkdir(output, { recursive: true });
const issuer = `https://ux-daily-${Date.now()}.synthetic.invalid`;
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
    ledger = await ledgers.create(actor, {
      name: '合成個人日常生活帳本與非常長的帳本名稱',
    });
  const cash = await itemService(db).create(actor, ledger.id, {
    name: '合成錢包',
    kind: 'asset',
    currency: 'TWD',
  });
  const expense = await itemService(db).create(actor, ledger.id, {
    name: '合成餐飲',
    kind: 'expense',
    currency: 'TWD',
  });
  const today = '2026-10-17';
  for (let i = 0; i < 30; i++)
    await transactionService(db).create(actor, ledger.id, {
      occurred_on: '2026-10-01',
      memo: '合成日常紀錄 ' + i,
      entries: [
        { item_id: cash.id, amount: '-100' },
        { item_id: expense.id, amount: '100' },
      ],
    });
  for (let i = 0; i < 12; i++)
    await namedRecordService(db, 'payees').create(actor, ledger.id, {
      name: '合成收付人 ' + i,
    });
  const emptyLedger = await ledgers.create(actor, { name: '合成第二帳本' });
  const make = (name, kind, currency = 'TWD') =>
    itemService(db).create(actor, ledger.id, { name, kind, currency });
  const income = await make('合成薪資', 'income'),
    usd = await make('合成美元帳戶', 'asset', 'USD'),
    transport = await make('合成銀行', 'asset'),
    liability = await make('合成信用卡', 'liability');
  const tx = transactionService(db);
  await tx.create(actor, ledger.id, {
    occurred_on: today,
    memo: '合成收入',
    entries: [
      { item_id: income.id, amount: '-52000' },
      { item_id: cash.id, amount: '52000' },
    ],
  });
  await tx.create(actor, ledger.id, {
    occurred_on: '2026-10-10',
    memo: '合成多分錄',
    entries: [
      { item_id: cash.id, amount: '-300' },
      { item_id: expense.id, amount: '200' },
      { item_id: transport.id, amount: '100' },
    ],
  });
  await tx.create(actor, ledger.id, {
    occurred_on: '2026-10-10',
    memo: '合成同日一般支出',
    entries: [
      { item_id: cash.id, amount: '-220' },
      { item_id: expense.id, amount: '220' },
    ],
  });
  await tx.create(actor, ledger.id, {
    occurred_on: today,
    memo: '合成外幣換匯',
    entries: [
      { item_id: usd.id, amount: '-100', exchange_rate: '32.5' },
      { item_id: cash.id, amount: '4000' },
    ],
  });
  await tx.create(actor, ledger.id, {
    occurred_on: today,
    memo: '合成負債轉帳',
    entries: [
      { item_id: liability.id, amount: '-1000' },
      { item_id: cash.id, amount: '1000' },
    ],
  });
  for (const offset of [-1, -2]) {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + offset);
    await tx.create(actor, ledger.id, {
      occurred_on: d.toISOString().slice(0, 10),
      memo: '合成歷史月收入',
      entries: [
        { item_id: income.id, amount: '-40000' },
        { item_id: cash.id, amount: '40000' },
      ],
    });
  }

  await itemService(db).update(actor, ledger.id, liability.id, {
    credit_card: true,
  });
  // Three-level synthetic account hierarchy, attached after historical postings.
  const branch = await make('合成外幣分組', 'asset');
  await itemService(db).update(actor, ledger.id, branch.id, {
    parent_id: transport.id,
  });
  await itemService(db).update(actor, ledger.id, usd.id, {
    parent_id: branch.id,
  });
  const zeroParent = await make('合成零額父科目', 'asset');
  const zeroLeaf = await make('合成零額末端', 'asset');
  await itemService(db).update(actor, ledger.id, zeroLeaf.id, {
    parent_id: zeroParent.id,
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
  await page.clock.setFixedTime(new Date('2026-10-17T04:00:00Z'));
  page.setDefaultTimeout(15000);
  const openTools = async () => {
    await page.getByRole('button', { name: /^篩選與工具/ }).click();
  };
  const closeTools = async () => {
    await page
      .getByRole('button', { name: '關閉篩選與工具', exact: true })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const external = [],
    fonts = [],
    homeCharts = [];
  let matrixRoute = '';
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'https:' && u.hostname !== 'localhost')
      external.push(u.origin);
    if (r.resourceType() === 'font') fonts.push(u.pathname);
    if (matrixRoute === '/' && u.pathname.includes('report-charts-'))
      homeCharts.push(u.pathname);
  });
  const routes = [
    '/',
    '/transactions',
    '/transactions?keyword=合成多分錄',
    '/transactions?keyword=不存在的合成內容',
  ];
  const results = [];
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      for (const [index, route] of routes.entries()) {
        matrixRoute = route;
        await page.goto('https://localhost:18444' + route);
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => globalThis.document.fonts.ready);
        assert.equal(
          await page.getByRole('tablist').count(),
          0,
          'no legacy tabs on daily routes',
        );
        assert.equal(
          await page
            .getByRole('button', { name: '管理目前帳本', exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.evaluate(
            () =>
              globalThis.document.documentElement.scrollWidth >
              globalThis.innerWidth,
          ),
          false,
        );
        const scan = await new AxeBuilder({ page })
          .withRules(['color-contrast'])
          .analyze();
        assert.deepEqual(
          scan.violations,
          [],
          route + ' ' + width + ' ' + theme,
        );
        if (index === 0) {
          const accounts = page.getByLabel('帳戶餘額分類', { exact: true });
          await accounts.getByText('合成銀行', { exact: true }).waitFor();
          assert.equal(
            await accounts.getByText('合成外幣分組', { exact: true }).count(),
            0,
            'third level starts collapsed',
          );
          assert.equal(
            await accounts.getByText('合成零額父科目', { exact: true }).count(),
            0,
          );
          const balance = await page.evaluate(
            async (id) =>
              (
                await fetch(
                  `/api/ledgers/${id}/reports/balance-sheet?as_of=2026-10-17`,
                )
              ).json(),
            ledger.id,
          );
          const treeRow = (name) =>
            accounts
              .locator(width < 900 ? 'article' : 'tbody tr')
              .filter({ has: page.getByText(name, { exact: true }) });
          assert.equal(
            balance.items.find((i) => i.id === liability.id).credit_card,
            true,
          );
          for (const [name, apiAmount, expectedAmount, expectedText] of [
            ['資產', balance.totals.assets, '129580.00', 'NT$ 129,580.00'],
            ['負債', balance.totals.liabilities, '1000.00', 'NT$ 1,000.00'],
          ]) {
            assert.equal(
              apiAmount,
              expectedAmount,
              'independently calculated synthetic book subtotal ' + name,
            );
            assert.ok(
              (await treeRow(name).textContent()).includes(expectedText),
              'exact 2-decimal API book subtotal ' + name,
            );
          }
          await accounts
            .getByRole('button', { name: '展開合成銀行', exact: true })
            .focus();
          await page.keyboard.press('Enter');
          await accounts
            .getByRole('button', { name: '展開合成外幣分組', exact: true })
            .click();
          await accounts.getByText('合成美元帳戶', { exact: true }).waitFor();
          assert.match(await treeRow('合成美元帳戶').textContent(), /USD 100/);
          await accounts.getByRole('switch', { name: '顯示 0 餘額' }).check();
          await accounts.getByText('合成零額父科目', { exact: true }).waitFor();
          await page.reload();
          await page
            .getByLabel('帳戶餘額分類', { exact: true })
            .getByText('合成美元帳戶', { exact: true })
            .waitFor();
          assert.equal(
            await accounts
              .getByRole('button', { name: '收合合成銀行', exact: true })
              .getAttribute('aria-expanded'),
            'true',
          );
          assert.equal(
            await accounts
              .getByRole('switch', { name: '顯示 0 餘額' })
              .isChecked(),
            true,
          );
          await accounts.evaluate((el) =>
            el.scrollIntoView({ block: 'start' }),
          );
          await page.screenshot({
            path: `${output}/account-tree-${width}-${theme}.png`,
            animations: 'disabled',
            fullPage: true,
          });
          assert.deepEqual(
            (
              await new AxeBuilder({ page })
                .withRules(['color-contrast'])
                .analyze()
            ).violations,
            [],
          );
          assert.equal(
            await page.evaluate(
              () =>
                globalThis.document.documentElement.scrollWidth >
                globalThis.innerWidth,
            ),
            false,
          );
          // Reset this ledger to defaults for the next viewport/theme matrix.
          await accounts
            .getByRole('button', { name: '收合合成外幣分組', exact: true })
            .click();
          await accounts
            .getByRole('button', { name: '收合合成銀行', exact: true })
            .click();
          await accounts.getByRole('switch', { name: '顯示 0 餘額' }).uncheck();

          assert.match(
            await page
              .locator('.kpi')
              .filter({
                has: page.getByRole('heading', {
                  name: '本月收入',
                  exact: true,
                }),
              })
              .textContent(),
            /NT\$ 52,000/,
          );
          assert.match(
            await page
              .locator('.kpi')
              .filter({
                has: page.getByRole('heading', {
                  name: '本月支出',
                  exact: true,
                }),
              })
              .textContent(),
            /NT\$ 3,420/,
          );
          assert.equal(
            await page.getByRole('heading', { name: '近三個月收支' }).count(),
            1,
          );
          assert.equal(
            await page.getByRole('heading', { name: '最近交易' }).count(),
            1,
          );
        }
        if (width < 900 && index === 0) {
          const wrapping = await page
            .locator('.kpi-value, .month-label')
            .evaluateAll((els) =>
              els
                .filter((el) => {
                  const range = globalThis.document.createRange();
                  range.selectNodeContents(el);
                  return (
                    range.getClientRects().length !== 1 ||
                    el.scrollWidth > el.clientWidth + 1
                  );
                })
                .map((el) => el.textContent),
            );
          assert.deepEqual(
            wrapping,
            [],
            'KPI and month labels must fit a single line',
          );
        }
        if (index === 1) {
          await page.locator('.query-totals').getByText(/3,420/).waitFor();
          assert.equal(
            await page
              .getByRole('button', { name: '查看分錄', exact: true })
              .count(),
            0,
          );
          if (width < 900) {
            const fullyVisible = await page.locator('.tx-card').evaluateAll(
              (els) =>
                els.filter((el) => {
                  const rect = el.getBoundingClientRect(),
                    bottom = globalThis.document
                      .querySelector('.bottom-nav')
                      .getBoundingClientRect().top;
                  return rect.top >= 60 && rect.bottom <= bottom;
                }).length,
            );
            assert.ok(
              fullyVisible >= 3,
              `First screen has ${fullyVisible} complete cards at ${width}`,
            );
            results.push({
              width,
              height,
              theme,
              firstScreenCards: fullyVisible,
            });
          }
        }
        await page.screenshot({
          path:
            output +
            '/' +
            (index === 0
              ? 'overview'
              : index === 1
                ? 'transactions'
                : index === 2
                  ? 'filtered'
                  : 'empty-filter') +
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
          route,
          width,
          height,
          contrastViolations: 0,
          horizontalOverflow: false,
        });
        if (index === 2) {
          await page
            .getByRole('button', { name: '展開多筆分錄', exact: true })
            .filter({ visible: true })
            .click();
          await page
            .getByText('合成銀行', { exact: true })
            .filter({ visible: true })
            .waitFor();
          await page.screenshot({
            path:
              output +
              '/expanded-' +
              width +
              'x' +
              height +
              '-' +
              theme +
              '.png',
            animations: 'disabled',
          });
        }
      }
    }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://localhost:18444/transactions?keyword=合成日常');
  await page.waitForLoadState('networkidle');
  await openTools();
  await page
    .getByRole('textbox', { name: '每次載入筆數', exact: true })
    .click();
  await page.getByRole('option', { name: '10', exact: true }).click();
  await closeTools();
  await page.getByText('已載入 10／30 筆', { exact: true }).waitFor();
  await page
    .locator('.day-heading')
    .getByText('日淨額 −NT$ 3,000', { exact: true })
    .waitFor();
  for (const count of [20, 30]) {
    await page.getByRole('button', { name: '載入更多', exact: true }).click();
    await page
      .getByText('已載入 ' + count + '／30 筆', { exact: true })
      .waitFor();
  }
  const visibleRows = page
    .getByTestId('query-transaction')
    .filter({ visible: true });
  assert.equal(await visibleRows.count(), 30);
  assert.equal(
    new Set(await visibleRows.locator('.tx-edit').allTextContents()).size,
    30,
  );
  assert.equal(
    await page
      .getByRole('button', { name: '載入更多', exact: true })
      .isDisabled(),
    true,
  );
  const viewport = page.getByLabel('主內容', { exact: true });
  await viewport.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.getByRole('button', { name: '回到頂端 ↑', exact: true }).click();
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[aria-label="主內容"]').scrollTop ===
      0,
  );
  await page.getByLabel('關鍵字', { exact: true }).fill('合成外幣');
  await page.getByLabel('關鍵字', { exact: true }).press('Enter');
  await page.getByText('已載入 1／1 筆', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('keyword'), '合成外幣');
  await page.reload();
  await page.getByText('已載入 1／1 筆', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('關鍵字', { exact: true }).inputValue(),
    '合成外幣',
  );
  await page.goto('https://localhost:18444/transactions?keyword=合成日常');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('關鍵字', { exact: true }).fill('合成多分錄');
  await page.getByLabel('關鍵字', { exact: true }).press('Enter');
  await page.getByText('已載入 1／1 筆', { exact: true }).waitFor();
  await page.goBack();
  await page.getByText(/^共 30 筆/).waitFor();
  assert.equal(
    await page.getByLabel('關鍵字', { exact: true }).inputValue(),
    '合成日常',
  );
  // Export is the full applied result, independent of the loaded cursor pages.
  await openTools();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出 CSV', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '匯出明細 CSV', exact: true })
    .click();
  const download = await pending;
  await download.saveAs(output + '/synthetic-detail.csv');
  const csv = await readFile(output + '/synthetic-detail.csv');
  assert.deepEqual([...csv.subarray(0, 3)], [239, 187, 191]);
  assert.equal(parse(csv, { bom: true }).length, 31);
  // The export menu remains in the tools sheet.

  await page.getByLabel('最小交易金額（本位幣）', { exact: true }).fill('100');
  await page.getByRole('button', { name: '套用進階篩選', exact: true }).click();
  await page.waitForLoadState('networkidle');
  assert.equal(new URL(page.url()).searchParams.get('amount_min'), '100');
  await page.goto(
    'https://localhost:18444/transactions?date_from=2026-10-01&date_to=2026-10-31',
  );
  await page.waitForLoadState('networkidle');
  await page.locator('.query-totals').getByText(/3,420/).waitFor();
  await page
    .locator('.day-heading')
    .getByText('日淨額 −NT$ 420', { exact: true })
    .waitFor();
  const summaryResponse = await context.request.get(
    `https://localhost:18444/api/ledgers/${ledger.id}/transactions/summary?group_by=item&date_from=2026-10-01&date_to=2026-10-31`,
  );
  const summaryBody = await summaryResponse.json();
  assert.equal(summaryResponse.status(), 200);
  assert.equal(
    summaryBody.items.find((i) => i.id === expense.id).natural_amount,
    '3420.000000',
  );
  await page.screenshot({ path: output + '/pnl-regression-390.png' });
  await openTools();
  await page.screenshot({ path: output + '/tools-390.png' });
  await closeTools();
  await page.goto(
    `https://localhost:18444/transactions?date_from=2026-10-10&date_to=2026-10-10&item_id=${cash.id}`,
  );
  await page.waitForLoadState('networkidle');
  await page
    .locator('.query-totals')
    .getByText(/科目淨變動/)
    .waitFor();
  assert.match(await page.locator('.query-totals').textContent(), /520/);
  assert.doesNotMatch(
    await page.locator('.query-totals').textContent(),
    /收入|支出/,
  );
  await page
    .locator('.day-heading')
    .getByText('科目淨變動 −NT$ 520', { exact: true })
    .waitFor();
  await page.screenshot({ path: output + '/selected-net-390.png' });
  await writeFile(
    output + '/pnl-regression.json',
    JSON.stringify(
      {
        month: '2026-10',
        day: '2026-10-10',
        dayNet: '-420',
        overviewExpense: '3420',
        detailExpense: '3420',
        selectedCashNet: '-520',
        mixedEntries: ['-300', '200', '100'],
        source: 'summary group_by=item own natural_amount',
      },
      null,
      2,
    ),
  );
  // Phone kind chips apply immediately without a separate submit.
  await page.getByRole('button', { name: '收入', exact: true }).click();
  await page.waitForURL(/kind=income/);
  await page.goto('https://localhost:18444/transactions?keyword=合成多分錄');
  await page.getByRole('button', { name: '合成多分錄', exact: true }).click();
  await page.getByRole('heading', { name: '修改交易', exact: true }).waitFor();
  assert.match(
    new URL(page.url()).searchParams.get('entry'),
    /^[0-9a-f-]{36}$/,
  );
  await page.locator('.entry-preview').waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '摘要', exact: true }).inputValue(),
    '合成多分錄',
  );
  await page.getByRole('button', { name: '關閉記帳', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  await page.goto('https://localhost:18444/');
  const accountPanel = page.getByLabel('帳戶餘額分類', { exact: true });
  await accountPanel.getByRole('switch', { name: '顯示 0 餘額' }).check();
  await accountPanel
    .getByRole('button', { name: '展開合成銀行', exact: true })
    .click();
  await page.getByRole('button', { name: '切換帳本', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '合成第二帳本 · TWD', exact: true })
    .click();
  await page.goto('https://localhost:18444');
  await page
    .getByRole('heading', { name: '還沒有交易', exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByLabel('帳戶餘額分類', { exact: true })
      .getByRole('switch', { name: '顯示 0 餘額' })
      .isChecked(),
    false,
    'new ledger has separate zero preference',
  );
  await page.getByRole('button', { name: '切換帳本', exact: true }).click();
  await page
    .getByRole('menuitem', { name: ledger.name + ' · TWD', exact: true })
    .click();
  await page
    .getByLabel('帳戶餘額分類', { exact: true })
    .getByRole('button', { name: '收合合成銀行', exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByLabel('帳戶餘額分類', { exact: true })
      .getByRole('switch', { name: '顯示 0 餘額' })
      .isChecked(),
    true,
    'first ledger state survives switching',
  );
  await page.getByRole('button', { name: '切換帳本', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '合成第二帳本 · TWD', exact: true })
    .click();
  await page
    .getByRole('heading', { name: '還沒有交易', exact: true })
    .waitFor();
  await page.screenshot({
    path: output + '/empty-ledger-390.png',
    animations: 'disabled',
  });
  assert.equal(emptyLedger.base_currency, 'TWD');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(homeCharts, []);
  await writeFile(
    output + '/result.json',
    JSON.stringify(
      {
        screenshots: 52,
        accountTree: {
          apiSubtotals: true,
          defaultDepth: true,
          zeroToggle: true,
          reloadPersistence: true,
          keyboard: true,
        },
        results,
        cursorAppend30Unique: true,
        urlReloadBack: true,
        filterResetsCursor: true,
        csvAllAppliedRows: true,
        mobileAdvanced: true,
        emptyLedger: true,
        legacyBlocksAbsent: true,
        compactLedgerMenu: true,
        existingEditBridge: true,
        colorContrastViolations: 0,
        horizontalOverflow: false,
        externalRequests: external,
        homeChartRequests: homeCharts,
      },
      null,
      2,
    ),
  );
  console.log(
    'UX daily matrix52 / cursor append30 unique / URL reload+back / filters+CSV / compact ledger / empty state PASS',
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
