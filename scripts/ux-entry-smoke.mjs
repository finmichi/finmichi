// SPDX-License-Identifier: AGPL-3.0-only
import { revealItemOption } from './item-picker-test.mjs';
// Synthetic HTTP → browser → DB acceptance; never point at a real ledger DB.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-entry';
await mkdir(output, { recursive: true });
const issuer = `https://ux-entry-${Date.now()}.synthetic.invalid`;
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
    }),
    items = itemService(db);
  const cash = await items.create(actor, ledger.id, {
      name: '合成現金',
      kind: 'asset',
      currency: 'TWD',
    }),
    expense = await items.create(actor, ledger.id, {
      name: '合成費用',
      kind: 'expense',
      currency: 'TWD',
    }),
    usd = await items.create(actor, ledger.id, {
      name: '合成美元資產',
      kind: 'asset',
      currency: 'USD',
    }),
    usdExpense = await items.create(actor, ledger.id, {
      name: '合成美元費用',
      kind: 'expense',
      currency: 'USD',
    });
  const traffic = await items.create(actor, ledger.id, {
    name: '合成交通',
    kind: 'expense',
    currency: 'TWD',
  });
  const transit = await items.create(actor, ledger.id, {
    name: '合成大眾運輸',
    kind: 'expense',
    currency: 'TWD',
    parent_id: traffic.id,
  });
  const metro = await items.create(actor, ledger.id, {
    name: '合成捷運',
    kind: 'expense',
    currency: 'TWD',
    parent_id: transit.id,
  });
  const archived = await items.create(actor, ledger.id, {
    name: '合成封存交通',
    kind: 'expense',
    currency: 'TWD',
    parent_id: traffic.id,
    archived: true,
  });
  const payee = await namedRecordService(db, 'payees').create(
      actor,
      ledger.id,
      { name: '合成收付人' },
    ),
    project = await namedRecordService(db, 'projects').create(
      actor,
      ledger.id,
      { name: '合成專案' },
    );
  await namedRecordService(db, 'memo_templates').create(actor, ledger.id, {
    name: '合成常用摘要',
    memo: '合成範本內容',
  });
  await db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES (${ledger.id},'2026-10-17','USD','TWD','32.567')`;
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

  const bank = await items.create(actor, ledger.id, {
    name: '合成銀行',
    kind: 'asset',
    currency: 'TWD',
  });
  const existing = await transactionService(db).create(actor, ledger.id, {
    occurred_on: '2026-10-17',
    memo: '合成既有交易',
    entries: [
      { item_id: cash.id, amount: '-135' },
      { item_id: expense.id, amount: '135' },
    ],
  });
  for (let i = 0; i < 35; i++)
    await transactionService(db).create(actor, ledger.id, {
      occurred_on: '2026-10-17',
      memo: '合成捲動交易' + i,
      entries: [
        { item_id: cash.id, amount: '-1' },
        { item_id: expense.id, amount: '1' },
      ],
    });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-10-17T04:00:00Z'));
  page.setDefaultTimeout(15000);
  const errors = [],
    external = [],
    results = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.error('BROWSER_ERROR', e.message);
  });
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol === 'https:' && url.hostname !== 'localhost')
      external.push(url.origin);
  });
  const field = (name) =>
    page.getByRole('textbox', { name: new RegExp('^' + name) });
  async function select(name, label) {
    await field(name).click();
    await revealItemOption(page, label);
    const option = page.getByRole('option', { name: label, exact: true });
    await option.waitFor({ state: 'visible' });
    if (page.viewportSize().width < 900) {
      const box = await option.boundingBox();
      assert.ok(
        box && box.height >= 44 && box.width >= 44,
        'phone option touch area',
      );
    }
    await option.click();
  }
  async function open() {
    await page
      .locator(
        page.viewportSize().width >= 900 ? '.primary-action' : '.entry-fab',
      )
      .click();
    await page
      .getByRole('heading', { name: '快速記帳', exact: true })
      .waitFor();
    await page.waitForLoadState('networkidle');
  }
  async function discard() {
    await page.getByRole('button', { name: '關閉記帳', exact: true }).click();
    await page
      .getByRole('heading', { name: '未儲存內容', exact: true })
      .waitFor();
    await page.getByRole('button', { name: '捨棄變更', exact: true }).click();
    await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  }
  async function quick() {
    await select('來源科目', '合成現金 (TWD)');
    await select('目的科目', '合成費用 (TWD)');
    await field('來源金額').fill('135');
    await page.locator('.entry-preview').waitFor();
  }
  async function shot(name, width, height, theme) {
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
        .locator('.entry-drawer-content')
        .evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    const scan = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .analyze();
    assert.deepEqual(scan.violations, [], name + ' ' + width + ' ' + theme);
    await page.screenshot({
      path: `${output}/${name}-${width}x${height}-${theme}.png`,
      animations: 'disabled',
    });
    results.push({
      name,
      width,
      height,
      theme,
      contrastViolations: 0,
      horizontalOverflow: false,
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
      await page.goto('https://localhost:18444/transactions?keyword=合成');
      await page.waitForLoadState('networkidle');
      const main = page.getByLabel('主內容', { exact: true });
      await main.evaluate((el) => el.scrollTo({ top: 200 }));
      const oldScroll = await main.evaluate((el) => el.scrollTop),
        oldUrl = page.url();
      await open();
      const box = await page.locator('.entry-drawer-content').boundingBox();
      assert.ok(box);
      assert.equal(Math.round(box.width), width >= 900 ? 420 : width);
      assert.equal(Math.round(box.height), height);
      assert.equal(
        await page
          .locator('.entry-drawer-content')
          .evaluate((el) => el.contains(globalThis.document.activeElement)),
        true,
      );
      if (width < 900) {
        const close = await page
          .getByRole('button', { name: '關閉記帳', exact: true })
          .boundingBox();
        assert.ok(close && close.width >= 44 && close.height >= 44);
        const labels = await page
          .locator('.entry-editor .mantine-SegmentedControl-label')
          .evaluateAll((els) =>
            els.map((el) => ({
              width: el.getBoundingClientRect().width,
              height: el.getBoundingClientRect().height,
            })),
          );
        assert.ok(
          labels.length === 4 &&
            labels.every((box) => box.width >= 44 && box.height >= 44),
        );
      }
      await quick();
      await page
        .getByRole('button', { name: '合成常用摘要', exact: true })
        .click();
      assert.equal(await field('摘要').inputValue(), '合成範本內容');
      await page.locator('.entry-preview').waitFor();
      assert.match(
        await page.locator('.entry-preview').textContent(),
        /合成現金.*135.*合成費用.*135/,
      );
      assert.equal(
        await field('來源金額').evaluate(
          (el) => globalThis.globalThis.getComputedStyle(el).fontSize,
        ),
        '28px',
      );
      await page
        .locator('.entry-fields > .edge-viewport')
        .evaluate((el) => el.scrollTo({ top: 0 }));
      await shot('quick', width, height, theme);
      await page
        .locator('.entry-fields > .edge-viewport')
        .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await shot('preview', width, height, theme);
      await page.keyboard.press('Escape');
      await page
        .getByRole('heading', { name: '未儲存內容', exact: true })
        .waitFor();
      await shot('dirty-confirm', width, height, theme);
      await page.getByRole('button', { name: '繼續編輯', exact: true }).click();
      await page
        .getByRole('heading', { name: '未儲存內容', exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(await field('摘要').inputValue(), '合成範本內容');
      if (width >= 900)
        await page
          .locator('.mantine-Drawer-overlay')
          .click({ position: { x: 20, y: 100 } });
      else
        await page
          .getByRole('button', { name: '關閉記帳', exact: true })
          .click();
      await page.getByRole('button', { name: '捨棄變更', exact: true }).click();
      await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
      assert.equal(page.url(), oldUrl);
      assert.equal(await main.evaluate((el) => el.scrollTop), oldScroll);
      await page.waitForFunction(
        (selector) => globalThis.document.activeElement?.matches(selector),
        width >= 900 ? '.primary-action' : '.entry-fab',
      );
      await open();
      await page.keyboard.press('Escape');
      await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
      assert.equal(page.url(), oldUrl);
      // Existing edit is opened by the same row control, without replacing the background.
      await page.goto(
        'https://localhost:18444/transactions?keyword=合成既有交易',
      );
      await page.waitForLoadState('networkidle');
      await page
        .getByRole('button', { name: '合成既有交易', exact: true })
        .click();
      await page.waitForLoadState('networkidle');
      await page.locator('.entry-preview').waitFor();
      assert.equal(await field('摘要').inputValue(), '合成既有交易');
      await shot('edit', width, height, theme);
      await page.keyboard.press('Escape');
      await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
      await open();
      await page.getByText('進階', { exact: true }).click();
      await select('分錄 1 科目', '合成現金 (TWD)');
      await field('分錄 1 金額').fill('-100');
      await select('分錄 2 科目', '合成費用 (TWD)');
      await field('分錄 2 金額').fill('40');
      await page.getByRole('button', { name: '新增分錄', exact: true }).click();
      await select('分錄 3 科目', '合成銀行 (TWD)');
      await field('分錄 3 金額').fill('60');
      await page.locator('.entry-preview').waitFor();
      await shot('advanced', width, height, theme);
      await discard();
      await open();
      await field('來源科目').click();
      const itemSearch = page.getByRole('textbox', {
        name: '搜尋完整科目路徑',
        exact: true,
      });
      if (await itemSearch.isVisible()) await itemSearch.fill('不存在的新科目');
      else await field('來源科目').fill('不存在的新科目');
      await page
        .getByRole('option', { name: '＋ 就地新增', exact: true })
        .click();
      const name = `合成就地科目${width}-${theme}`;
      await field('新增名稱').fill(name);
      await select('新增科目類型', '資產');
      await shot('inline-create', width, height, theme);
      await page
        .getByRole('button', { name: '建立並選取', exact: true })
        .click();
      await page
        .getByRole('heading', { name: '新增科目', exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(await field('來源科目').inputValue(), name + ' (TWD)');
      assert.equal(
        (
          await db`SELECT count(*) AS count FROM items WHERE ledger_id=${ledger.id} AND name=${name}`
        )[0].count,
        '1',
      );
      await discard();
      await open();
      await page
        .locator('.entry-drawer-content')
        .getByText('轉帳', { exact: true })
        .click();
      await select('來源科目', '合成美元資產 (USD)');
      await select('目的科目', '合成現金 (TWD)');
      await field('來源金額').fill('100');
      await field('目的金額').fill('4000');
      await page.getByLabel('交易日期', { exact: true }).fill('2026-10-18');
      await field('USD → TWD 匯率').fill('32.5');
      await page.getByText(/有效匯率偏離參考匯率超過 5%/).waitFor();
      assert.match(
        await page.locator('.entry-drawer-content').innerText(),
        /偏差 23\.08%/,
      );
      const previewText = await page
        .locator('.entry-drawer-content')
        .innerText();
      assert.match(
        previewText,
        /分錄 1：−USD 100\.00；本位幣 −NT\$ 4,000\.00；有效匯率 40\.0000(?!\d)/,
      );
      assert.match(previewText, /參考來源：使用者輸入 32\.5000(?!\d)/);
      assert.doesNotMatch(previewText, /40\.0000000000|32\.5000000000/);
      assert.ok(
        (await page.locator('[title="完整匯率：40.0000000000"]').count()) >= 1,
      );
      assert.ok(
        (await page.locator('[title="完整匯率：32.5000000000"]').count()) >= 1,
      );
      assert.equal(
        await page.locator('.entry-fx-warning').evaluate((el) => {
          const sample = globalThis.document.createElement('span');
          sample.style.color = 'var(--warn)';
          el.append(sample);
          const expected = globalThis.getComputedStyle(sample).color;
          sample.remove();
          return (
            globalThis.getComputedStyle(el).borderInlineStartColor === expected
          );
        }),
        true,
      );
      assert.equal(
        await page
          .getByRole('button', { name: '儲存交易', exact: true })
          .isDisabled(),
        true,
      );
      await page
        .locator('.entry-fields > .edge-viewport')
        .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await shot('fx-warning', width, height, theme);
      await discard();
    }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://localhost:18444/transactions?keyword=合成');
  await page.waitForLoadState('networkidle');
  await open();
  await quick();
  for (const [label, name] of [
    ['收付人', '合成就地收付人'],
    ['專案', '合成就地專案'],
  ]) {
    await field(label).click();
    await page
      .getByRole('option', { name: '＋ 就地新增', exact: true })
      .click();
    await field('新增名稱').fill(name);
    await page.getByRole('button', { name: '建立並選取', exact: true }).click();
    await page.waitForFunction(
      ({ label, name }) =>
        [...globalThis.document.querySelectorAll('label')]
          .filter((el) => el.textContent === label)
          .some(
            (el) =>
              globalThis.document.getElementById(el.htmlFor)?.value === name,
          ),
      { label, name },
    );
  }
  await field('摘要').fill('合成第三批寫入');
  await page
    .getByRole('button', { name: '發票與進階欄位', exact: true })
    .click();
  await field('發票號碼').fill('SYNTHETIC-ENTRY-01');
  await page.locator('.entry-preview').waitFor();
  await page.getByRole('button', { name: '儲存交易', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  await page.getByRole('status').filter({ hasText: '交易已儲存。' }).waitFor();
  const stored = (
    await db`SELECT id,kind,payee_id,project_id,invoice_no FROM transactions WHERE ledger_id=${ledger.id} AND memo='合成第三批寫入'`
  )[0];
  assert.equal(stored.kind, 'expense');
  assert.ok(stored.payee_id && stored.project_id);
  assert.equal(stored.invoice_no, 'SYNTHETIC-ENTRY-01');
  await page
    .getByRole('button', { name: '合成第三批寫入', exact: true })
    .click();
  await page.waitForLoadState('networkidle');
  await field('摘要').fill('合成第三批修改');
  await page.locator('.entry-preview').waitFor();
  await page.getByRole('button', { name: '儲存交易', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  assert.equal(
    (await db`SELECT memo FROM transactions WHERE id=${stored.id}`)[0].memo,
    '合成第三批修改',
  );
  const incomeItem = await items.create(actor, ledger.id, {
    name: '合成收入來源',
    kind: 'income',
    currency: 'TWD',
  });
  await open();
  await page
    .locator('.entry-drawer-content')
    .getByText('收入', { exact: true })
    .click();
  await select('來源科目', '合成收入來源 (TWD)');
  await select('目的科目', '合成現金 (TWD)');
  await field('來源金額').fill('50');
  await field('摘要').fill('合成快捷收入');
  await page.locator('.entry-preview').waitFor();
  await page.getByRole('button', { name: '儲存交易', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  assert.equal(
    (
      await db`SELECT kind FROM transactions WHERE ledger_id=${ledger.id} AND memo='合成快捷收入'`
    )[0].kind,
    'income',
  );
  assert.ok(incomeItem.id);
  await page.goto(
    'https://localhost:18444/transactions?entry=00000000-0000-4000-8000-000000000001',
  );
  await page.getByRole('alert').filter({ hasText: '找不到資料' }).waitFor();
  assert.equal(await field('來源金額').isDisabled(), true);
  assert.equal(
    await page
      .getByRole('button', { name: '儲存交易', exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole('button', { name: '關閉記帳', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  // Browser back is guarded in-page, and refusing it leaves the draft untouched.
  await open();
  await field('摘要').fill('合成尚未儲存');
  await page.goBack();
  await page
    .getByRole('heading', { name: '未儲存內容', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '繼續編輯', exact: true }).click();
  assert.equal(await field('摘要').inputValue(), '合成尚未儲存');
  await page.goBack();
  await page
    .getByRole('heading', { name: '未儲存內容', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '捨棄變更', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).searchParams.has('entry'), false);
  const count = (
    await db`SELECT count(*) AS count FROM transactions WHERE ledger_id=${ledger.id}`
  )[0].count;
  await page.getByRole('button', { name: '載入更多', exact: true }).click();
  await page
    .getByText(`已載入 ${count}／${count} 筆`, { exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: '合成捲動交易0', exact: true })
    .click();
  await page.locator('.entry-preview').waitFor();
  const originalScroll = await page
    .getByLabel('主內容', { exact: true })
    .evaluate((el) => el.scrollTop);
  await field('摘要').fill('合成捲動交易0 已修改');
  await page.locator('.entry-preview').waitFor();
  await page.getByRole('button', { name: '儲存交易', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: '合成捲動交易0 已修改', exact: true })
    .waitFor();
  await page
    .getByText(`已載入 ${count}／${count} 筆`, { exact: true })
    .waitFor();
  await page.waitForFunction(
    (expected) =>
      globalThis.document.querySelector('[aria-label="主內容"]').scrollTop ===
      expected,
    originalScroll,
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await open();
  await quick();
  await field('摘要').fill('合成連續新增');
  await page.locator('.entry-preview').waitFor();
  await page
    .getByRole('button', { name: '儲存並新增下一筆', exact: true })
    .click();
  await page.getByRole('status').filter({ hasText: '交易已儲存。' }).waitFor();
  assert.equal(await field('來源金額').inputValue(), '');
  await page.keyboard.press('Escape');
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  assert.equal(
    (
      await db`SELECT count(*) AS count FROM transactions WHERE ledger_id=${ledger.id} AND memo='合成連續新增'`
    )[0].count,
    '1',
  );
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto('https://localhost:18444/transactions');
      await page.waitForLoadState('networkidle');
      await open();
      await field('目的科目').click();
      if (width < 900) {
        await page
          .getByRole('option', { name: '合成交通 ›', exact: true })
          .click();
        assert.equal(
          await page.getByRole('option', { name: /合成封存交通/ }).count(),
          0,
        );
        await shot('item-picker-category', width, height, theme);
        await page
          .getByRole('button', { name: '返回大類別', exact: true })
          .click();
        await page
          .getByRole('textbox', { name: '搜尋完整科目路徑', exact: true })
          .fill('合成捷運');
      } else {
        await field('目的科目').fill('合成捷運');
        await shot('item-picker-path', width, height, theme);
      }
      const leafLabel = '合成交通 › 合成大眾運輸 › 合成捷運 (TWD)';
      await page.getByRole('option', { name: leafLabel, exact: true }).click();
      assert.equal(await field('目的科目').inputValue(), leafLabel);
      await field('目的科目').click();
      if (width < 900)
        await page
          .getByRole('textbox', { name: '搜尋完整科目路徑', exact: true })
          .fill('合成捷運');
      else await field('目的科目').fill('合成捷運');
      const keyboardTarget =
        width < 900
          ? page.getByRole('textbox', { name: '搜尋完整科目路徑', exact: true })
          : field('目的科目');
      await keyboardTarget.press('ArrowDown');
      await keyboardTarget.press('Enter');
      assert.equal(await field('目的科目').inputValue(), leafLabel);
      await page.keyboard.press('Escape');
      await page
        .getByRole('heading', { name: '未儲存內容', exact: true })
        .waitFor();
      await page.getByRole('button', { name: '捨棄變更', exact: true }).click();
      await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
    }
  assert.ok(metro.id && archived.id);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.ok(
    existing.id && bank.id && usd.id && usdExpense.id && payee.id && project.id,
  );
  await writeFile(
    output + '/result.json',
    JSON.stringify(
      {
        screenshots: 60,
        hierarchicalPickerKeyboard: true,
        postingParentsAndArchivesExcluded: true,
        phoneTouchTargets44: true,
        results,
        inlineItemAutoSelect: true,
        incomeMode: true,
        missingEdit404Blocked: true,
        inlinePayeeProjectAutoSelect: true,
        quickCreateEditSQL: true,
        saveNext: true,
        autoPreview: true,
        fxWarning23_08: true,
        previewMoneyTypography: true,
        ratesFourPlacesWithFullTitle: true,
        warningTokenBothThemes: true,
        dirtyEscapeOverlayBack: true,
        originalPathFiltersScrollFocus: true,
        preservesLoadedPrefixAfterEdit: true,
        externalRequests: external,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'UX entry60 / hierarchical picker+keyboard / 4 sizes+2 themes / drawer420+phone full-screen / inline3 resources+auto-select / auto preview+FX / edit+save-next / dirty Esc+overlay+back / original path+scroll+focus PASS',
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
