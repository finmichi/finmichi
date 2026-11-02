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
  financeService,
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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-finance';
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
  await ledgerService(db).create(actor, {
    name: '合成空帳本',
  });

  const now = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const dateAgo = new Date(now + 'T00:00:00Z');
  dateAgo.setUTCDate(1);
  dateAgo.setUTCMonth(dateAgo.getUTCMonth() - 2);
  const first = dateAgo.toISOString().slice(0, 10),
    finance = financeService(db),
    item = itemService(db),
    tx = transactionService(db);
  const card = (
      await item.create(actor, ledger.id, {
        name: '合成信用卡',
        kind: 'liability',
        currency: 'TWD',
        credit_card: true,
      })
    ).id,
    loan = (
      await item.create(actor, ledger.id, {
        name: '合成房屋貸款',
        kind: 'liability',
        currency: 'TWD',
        loan: true,
      })
    ).id,
    small = (
      await item.create(actor, ledger.id, {
        name: '合成零利率小額貸款',
        kind: 'liability',
        currency: 'TWD',
        loan: true,
      })
    ).id;
  for (const [name, kind, flags] of [
    ['合成美元信用卡', 'liability', { credit_card: true }],
    ['合成美元貸款', 'liability', { loan: true }],
    ['合成美元銀行', 'asset', {}],
    ['合成美元利息', 'expense', {}],
  ])
    await item.create(actor, ledger.id, {
      name,
      kind,
      currency: 'USD',
      ...flags,
    });
  await finance.saveCard(actor, ledger.id, {
    item_id: card,
    statement_day: 15,
    due_day: 25,
    due_month_offset: 0,
    payment_account_id: fixture.bank,
    credit_limit: '100000',
  });
  for (const [id, principal, annual_rate] of [
    [loan, '1200000', '2.1'],
    [small, '0.06', '0'],
  ]) {
    await finance.saveLoan(actor, ledger.id, {
      item_id: id,
      principal,
      annual_rate,
      term_months: 12,
      first_payment_on: first,
      method: 'annuity',
      payment_account_id: fixture.bank,
      interest_item_id: fixture.food,
    });
    await tx.create(actor, ledger.id, {
      occurred_on: first,
      entries: [
        { item_id: id, amount: '-' + principal },
        { item_id: fixture.bank, amount: principal },
      ],
    });
  }
  await tx.create(actor, ledger.id, {
    occurred_on: first,
    entries: [
      { item_id: card, amount: '-4200' },
      { item_id: fixture.food, amount: '4200' },
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
    external = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname))
      external.push(u.origin);
  });
  await context.addInitScript(
    ({ id }) => globalThis.localStorage.setItem('finmichi-ledger', id),
    { id: ledger.id },
  );
  async function settle() {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => globalThis.document.fonts.ready);
  }
  async function paymentReady(mode) {
    // Wait for catalog-backed prefill, without changing the default timeout.
    await page.waitForFunction(
      (value) =>
        globalThis.document.querySelector(
          `input[type="radio"][value="${value}"]`,
        )?.checked,
      mode,
    );
  }
  async function capture(name, width, height, theme) {
    await page.evaluate(() => globalThis.document.fonts.ready);
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth ||
        [
          ...globalThis.document.querySelectorAll(
            '.admin-content,.finance-page',
          ),
        ].some((e) => e.scrollWidth > e.clientWidth + 1),
    );
    if (overflow)
      await page.screenshot({ path: output + '/overflow-debug.png' });
    assert.equal(overflow, false, name);
    const clipped = await page.evaluate(() =>
      [
        ...globalThis.document.querySelectorAll('.finance-page,.finance-card'),
      ].some((e) => {
        const b = e.getBoundingClientRect();
        return b.left < 0 || b.right > globalThis.innerWidth + 1;
      }),
    );
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
      for (const type of ['cards', 'loans']) {
        const title = type === 'cards' ? '合成信用卡' : '合成房屋貸款',
          endpoint = `**/api/ledgers/*/${type}`;
        await page.goto('https://localhost:18444/admin/' + type);
        await page.getByLabel('主題', { exact: true }).selectOption(theme);
        await settle();
        await page.getByRole('heading', { name: title, exact: true }).waitFor();
        const names = await page
          .locator('.finance-card button[aria-label^="繳款 "]')
          .evaluateAll((buttons) =>
            buttons.map((b) => b.getAttribute('aria-label')),
          );
        assert.equal(new Set(names).size, names.length);
        assert.ok(
          names.every((n) =>
            type === 'cards'
              ? /^繳款 合成信用卡 \d{4}-\d{2}-\d{2} 帳單$/.test(n)
              : /^繳款 .+ 第 \d+ 期 \d{4}-\d{2}-\d{2}/.test(n),
          ),
        );
        await capture(type + '-data', width, height, theme);
        if (width < 900) {
          const edge = page.locator('.finance-card .edge-scroll').first();
          const scroll = edge.locator('.edge-viewport');
          const left = await scroll.evaluate((e) => e.scrollLeft);
          await edge
            .getByRole('button', { name: '向右捲動', exact: true })
            .click();
          assert.ok((await scroll.evaluate((e) => e.scrollLeft)) > left);
          await scroll.evaluate((e) => {
            e.scrollLeft = 0;
          });
        }
        if (type === 'loans') {
          const smallSection = page.locator('.finance-card').filter({
            has: page.getByRole('heading', {
              name: '合成零利率小額貸款',
              exact: true,
            }),
          });
          assert.equal(
            await smallSection.locator('details').getAttribute('open'),
            null,
          );
          assert.equal(
            await smallSection.getByRole('button', { name: /^繳款 / }).count(),
            2,
          );
          await smallSection.locator('summary').click();
          const paymentButtons = smallSection
            .locator('details')
            .getByRole('button', {
              name: /^繳款 合成零利率小額貸款 /,
            });
          assert.equal(await paymentButtons.count(), 12);
          assert.deepEqual(
            await Promise.all(
              Array.from({ length: 12 }, (_, i) =>
                paymentButtons.nth(i).isDisabled(),
              ),
            ),
            [...Array(11).fill(true), false],
          );
          await smallSection
            .getByText('本期無需繳款', { exact: true })
            .first()
            .waitFor();
          await smallSection.locator('summary').click();
        }
        const section = page.locator('.finance-card').filter({
          has: page.getByRole('heading', { name: title, exact: true }),
        });
        await section
          .getByRole('button', { name: '編輯' + title, exact: true })
          .click();
        const dialog = page.getByRole('dialog');
        await dialog
          .getByRole('button', { name: '儲存設定', exact: true })
          .waitFor();
        if (type === 'cards') {
          await dialog
            .getByRole('textbox', { name: '繳款月份', exact: true })
            .click();
          await page
            .getByRole('option', { name: '當月繳款', exact: true })
            .click();
          await dialog.getByLabel('結帳日', { exact: true }).fill('31');
          await dialog.getByRole('alert').waitFor();
        }
        await capture(type + '-editor', width, height, theme);
        await dialog
          .getByRole('button', { name: '關閉編輯', exact: true })
          .click();
        if (type === 'cards')
          await page
            .getByRole('button', { name: '捨棄變更', exact: true })
            .click();
        await page
          .getByRole('dialog', {
            name: (type === 'cards' ? '信用卡' : '貸款') + '設定',
            exact: true,
          })
          .waitFor({ state: 'hidden' });
        await section
          .getByRole('button', { name: /^繳款 / })
          .first()
          .click();
        await settle();
        try {
          await page
            .getByRole('dialog')
            .getByRole('button', { name: '儲存繳款交易', exact: true })
            .waitFor();
          await paymentReady(type === 'cards' ? 'transfer' : 'advanced');
        } catch (error) {
          await page.screenshot({ path: output + '/failure.png' });
          await writeFile(
            output + '/failure.json',
            JSON.stringify(
              {
                stage: type + '-' + width + '-' + theme + '-payment',
                url: page.url(),
                buttons: await page
                  .getByRole('dialog')
                  .getByRole('button')
                  .allTextContents(),
                errors,
              },
              null,
              2,
            ),
          );
          throw error;
        }
        if (type === 'cards') {
          assert.equal(
            await page
              .getByRole('radio', { name: '轉帳', exact: true })
              .isChecked(),
            true,
          );
          assert.equal(await page.getByLabel(/^來源金額/).inputValue(), '4200');
          assert.equal(await page.getByLabel(/^分錄 1 金額/).count(), 0);
        } else {
          assert.equal(
            await page
              .getByRole('radio', { name: '進階', exact: true })
              .isChecked(),
            true,
          );
          const amounts = await page.getByLabel(/^分錄 \d+ 金額/).all();
          assert.equal(amounts.length, 3);
          for (const v of amounts)
            assert.match(await v.inputValue(), /^-?\d+(?:\.\d{1,2})?$/);
        }
        await capture(type + '-payment', width, height, theme);
        await page
          .getByRole('button', { name: '關閉記帳', exact: true })
          .click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        for (const state of ['empty', 'error', 'loading']) {
          let release;
          const waiting = new Promise((resolve) => {
            release = resolve;
          });
          await page.route(endpoint, async (route) => {
            if (state === 'loading') await waiting;
            if (state === 'error')
              return route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'synthetic_error' }),
              });
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify(
                type === 'cards'
                  ? { as_of: now, cards: [], due_soon: [] }
                  : { as_of: now, loans: [] },
              ),
            });
          });
          await page.goto('https://localhost:18444/admin/' + type);
          if (state === 'loading')
            await page
              .getByRole('status', {
                name: '載入' + (type === 'cards' ? '信用卡' : '貸款'),
                exact: true,
              })
              .waitFor();
          else if (state === 'error') await page.getByRole('alert').waitFor();
          else
            await page
              .getByRole('heading', {
                name: '尚無' + (type === 'cards' ? '信用卡' : '貸款') + '設定',
                exact: true,
              })
              .waitFor();
          await capture(type + '-' + state, width, height, theme);
          release();
          await settle();
          await page.unroute(endpoint);
        }
      }
    }
  // Real 390px HTTP mutations and reference-safe settings edit/recalculation.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://localhost:18444/admin/loans');
  await settle();
  await page
    .getByRole('button', { name: '自今日重新試算', exact: true })
    .first()
    .click();
  assert.equal(
    await page.getByLabel('首期繳款日', { exact: true }).inputValue(),
    now,
  );
  await page.getByRole('button', { name: '儲存設定', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await settle();
  const saved = await finance.loans(actor, ledger.id);
  assert.equal(
    saved.loans.find((l) => l.item_id === loan).first_payment_on,
    now,
  );
  // rev1.2: the last small zero-rate period opens exactly two nonzero legs and saves via existing service.
  await page.goto('https://localhost:18444/admin/loans');
  await settle();
  const smallSection = page.locator('.finance-card').filter({
    has: page.getByRole('heading', {
      name: '合成零利率小額貸款',
      exact: true,
    }),
  });
  await smallSection.locator('summary').click();
  await smallSection
    .locator('details')
    .getByRole('button', { name: /^繳款 / })
    .last()
    .click();
  await settle();
  assert.equal(await page.getByLabel(/^分錄 1 金額/).inputValue(), '-0.06');
  assert.equal(await page.getByLabel(/^分錄 2 金額/).inputValue(), '0.06');
  assert.equal(await page.getByLabel(/^分錄 3 金額/).count(), 0);
  await page.getByRole('button', { name: '儲存繳款交易', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await settle();
  const [paid] =
    await db`SELECT count(*)::int n FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id WHERE e.item_id=${small} AND e.amount=0.06 AND t.occurred_on=${now}`;
  assert.equal(paid.n, 1);
  await page.goto('https://localhost:18444/admin/cards');
  await settle();
  await page
    .getByRole('button', { name: '編輯合成信用卡', exact: true })
    .click();
  await page.getByRole('textbox', { name: /^信用卡科目/ }).click();
  await revealItemOption(page, '合成美元信用卡（USD）');
  const foreignOption = page.getByRole('option', {
    name: '合成美元信用卡（USD）',
    exact: true,
  });
  assert.equal(
    await foreignOption.getAttribute('data-combobox-disabled'),
    null,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '關閉編輯', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.goto('https://localhost:18444/admin/cards');
  await settle();
  await page
    .getByRole('button', { name: /^繳款 合成信用卡 / })
    .first()
    .click();
  await page
    .getByRole('button', { name: '儲存繳款交易', exact: true })
    .waitFor();
  await paymentReady('transfer');
  assert.equal(await page.getByLabel(/^來源金額/).inputValue(), '4200');
  await page.getByRole('button', { name: '儲存繳款交易', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const [cardPaid] =
    await db`SELECT count(*)::int n FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id WHERE e.item_id=${card} AND e.amount=4200 AND t.occurred_on=${now}`;
  assert.equal(cardPaid.n, 1);
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
          'review fix: unique payment labels/normalized exact amounts/card quick transfer save/recent periods+collapsed full schedule; rev1.2 zero-payment disabled/card invalid schedule/recalculate save PASS',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS finance UX ${results.length} PNG; four sizes/two themes; data/editor/payment/empty/error/loading, axe0/overflow0/external0`,
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
