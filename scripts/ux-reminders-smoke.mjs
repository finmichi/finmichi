// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic localhost HTTP→browser→DB acceptance, no real financial inputs.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  ledgerService,
  itemService,
  depositService,
  financeService,
  transactionService,
  reminderService,
  forecastToday,
} from '../packages/core/dist/index.js';
import { addDays, monthDate } from '../packages/core/dist/finance-calendar.js';
import { createApp } from '../apps/server/dist/app.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const u = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1'].includes(u.hostname) ||
  !['/synthetic', '/life_test'].includes(u.pathname)
)
  throw new Error('Local synthetic DB only');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-reminders';
await mkdir(output, { recursive: true });
const issuer = `https://reminders-${Date.now()}.synthetic.invalid`,
  origin = 'https://localhost:18453';
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
  const sessions = sessionService(db, ['owner']),
    token = await sessions.login(issuer, 'owner'),
    actor = (await sessions.authenticate(token)).id;
  const l = await ledgerService(db).create(actor, { name: '合成提醒驗收' });
  const empty = await ledgerService(db).create(actor, { name: '合成空提醒' });
  const mk = (name, kind, currency = 'TWD') =>
    itemService(db).create(actor, l.id, {
      name,
      kind,
      currency,
      non_operating: kind === 'income',
    });
  const today = forecastToday(),
    bank = await mk('合成銀行', 'asset'),
    income = await mk('合成利息', 'income'),
    expense = await mk('合成支出', 'expense'),
    dep = await mk('合成定存', 'asset');
  await depositService(db).save(actor, l.id, {
    item_id: dep.id,
    bank: '合成到期銀行',
    principal: '1000',
    annual_rate: '1',
    start_on: addDays(today, -60),
    maturity_on: addDays(today, -22),
    interest_basis: 'daily',
    payout: 'at_maturity',
    auto_renew: false,
    payout_account_id: bank.id,
    interest_item_id: income.id,
    note: '',
  });
  const card = await itemService(db).create(actor, l.id, {
    name: '合成美元卡',
    kind: 'liability',
    currency: 'USD',
    credit_card: true,
  });
  const missing = await itemService(db).create(actor, l.id, {
    name: '合成缺行情卡',
    kind: 'liability',
    currency: 'XZZ',
    credit_card: true,
  });
  for (const c of [card, missing]) {
    await financeService(db).saveCard(actor, l.id, {
      item_id: c.id,
      statement_day: 1,
      due_day: 20,
      due_month_offset: 1,
      payment_account_id: bank.id,
      credit_limit: '1000',
    });
    await transactionService(db).create(actor, l.id, {
      // Three months back guarantees an overdue offset-1 bill even on day 1.
      occurred_on: monthDate(today, -3, 2),
      entries: [
        { item_id: c.id, amount: '-100' },
        { item_id: expense.id, amount: '3200' },
      ],
    });
  }
  await db`INSERT INTO market_fx_rates(rate_date,currency,source,spot_buy,spot_sell) VALUES(${today},'USD','bot',32,32.5) ON CONFLICT(rate_date,currency,source) DO UPDATE SET spot_buy=32,spot_sell=32.5`;
  await db`INSERT INTO recurring_occurrences(ledger_id,source_rule_id,rule_name,occurs_on,occurred_on,template,status) VALUES(${l.id},gen_random_uuid(),'合成規則',${today},${today},${db.json(
    {
      memo: '合成摘要',
      invoice_no: '',
      payee_id: null,
      project_id: null,
      entries: [
        { item_id: bank.id, amount: '-10' },
        { item_id: expense.id, amount: '10' },
      ],
    },
  )},'pending')`;
  const settled = await depositService(db).save(actor, l.id, {
    item_id: dep.id,
    bank: '合成已結清銀行',
    principal: '1000',
    annual_rate: '0',
    start_on: monthDate(today, -2),
    maturity_on: monthDate(today, -1),
    interest_basis: 'monthly',
    payout: 'monthly',
    auto_renew: false,
    payout_account_id: bank.id,
    interest_item_id: income.id,
    note: '',
  });
  const svc = depositService(db);
  for (const operation of ['interest', 'settlement']) {
    const amounts = {
      posted_on: today,
      gross_interest: '0',
      withholding_tax: '0',
      nhi_premium: '0',
      renew: 'none',
      ...(operation === 'interest' ? { period_no: 1 } : {}),
    };
    const preview = await svc.preview(actor, l.id, settled.id, {
      operation,
      amounts,
    });
    await svc.apply(actor, l.id, settled.id, operation, {
      ...amounts,
      preview_hash: preview.preview_hash,
    });
  }
  const seededReminders = await reminderService(db).list(actor, l.id);
  assert.equal(
    seededReminders.items.filter((r) => r.type === 'card' && r.date < today)
      .length,
    2,
    'Synthetic fixture must contain two overdue card bills on every calendar day',
  );
  app = await createApp(
    {
      databaseUrl,
      publicUrl: origin,
      issuer,
      clientId: 'synthetic',
      allowedSubjects: ['owner'],
      trustProxy: 0,
      version: 'test',
      mockInternalUrl: `http://127.0.0.1:${discovery.address().port}`,
      tlsKey: 'deploy/local/tls-key',
      tlsCert: 'deploy/local/tls-cert',
    },
    db,
  );
  await app.listen({ host: '127.0.0.1', port: 18453 });
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
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  await context.addInitScript((id) => {
    if (!globalThis.localStorage.getItem('finmichi-ledger'))
      globalThis.localStorage.setItem('finmichi-ledger', id);
  }, l.id);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [],
    external = [],
    states = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!['localhost', '127.0.0.1'].includes(new URL(r.url()).hostname))
      external.push(r.url());
  });
  const settle = async () => {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => globalThis.document.fonts.ready);
  };
  const go = async (path) => {
    await page.goto(origin + path);
    await settle();
  };
  async function capture(state, w, h, theme) {
    await page.evaluate(() => globalThis.document.fonts.ready);
    const overflow = await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    );
    assert.equal(overflow, false, state);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    if (axe.violations.length)
      await writeFile(
        output + '/debug-' + state + '.json',
        JSON.stringify(axe.violations, null, 2),
      );
    assert.deepEqual(axe.violations, [], state);
    const screenshot = `reminders-${state}-${w}x${h}-${theme}.png`;
    await page.screenshot({ path: output + '/' + screenshot });
    states.push({
      state,
      width: w,
      height: h,
      theme,
      screenshot,
      horizontalOverflow: overflow,
      violations: [],
    });
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: w, height: h });
      await go('/');
      await page.evaluate(
        ({ id, theme }) => {
          globalThis.localStorage.setItem('finmichi-ledger', id);
          globalThis.localStorage.setItem('finmichi-theme', theme);
        },
        { id: l.id, theme },
      );
      await page.reload();
      await settle();
      const section = page.getByRole('region', { name: '待處理提醒' });
      await section.locator('li').first().waitFor();
      assert.equal(await section.locator('li').count(), 3);
      await capture('overview', w, h, theme);
      const bell = page.getByRole('button', { name: /^提醒，\d+ 筆未讀$/ });
      await bell.click();
      await page.getByRole('dialog', { name: '提醒中心' }).waitFor();
      await settle();
      await capture('panel', w, h, theme);
      const mark = page.getByRole('button', { name: '全部標為已讀' });
      if (await mark.isEnabled()) {
        await mark.click();
        await page.getByRole('button', { name: '提醒，0 筆未讀' }).waitFor();
      }
      await page.getByRole('button', { name: '提醒設定', exact: true }).click();
      await page
        .getByRole('heading', { name: '提醒設定', exact: true })
        .waitFor();
      await settle();
      await capture('settings', w, h, theme);
      const daysField = page.getByLabel('定存到期提前天數');
      await daysField.fill((await daysField.inputValue()) === '8' ? '7' : '8');
      await page.getByRole('button', { name: '儲存提醒設定' }).click();
      await page.getByText('提醒設定已儲存。', { exact: true }).waitFor();
      await go('/admin/cards');
      await page
        .getByRole('heading', { name: '合成美元卡', exact: true })
        .waitFor();
      await capture('cards', w, h, theme);
      await page
        .getByRole('button', { name: /^繳款 合成美元卡 / })
        .first()
        .click();
      await page.getByLabel(/^分錄 1 金額/).waitFor();
      await settle();
      assert.equal(await page.getByLabel(/^分錄 1 金額/).inputValue(), '-3250');
      assert.equal(await page.getByLabel(/^分錄 2 金額/).inputValue(), '100');
      await page.getByText(/預估匯率 32.5000/).waitFor();
      await capture('payment', w, h, theme);
      await go('/admin/cards');
      await page
        .getByRole('button', { name: /^繳款 合成缺行情卡 / })
        .first()
        .click();
      await page.getByLabel(/^分錄 1 金額/).waitFor();
      await settle();
      assert.equal(await page.getByLabel(/^分錄 1 金額/).inputValue(), '');
      assert.equal(await page.getByLabel(/^分錄 2 金額/).inputValue(), '100');
      await page
        .getByText('缺少預估匯率，請填寫本位幣實際扣款金額。', { exact: true })
        .waitFor();
      await capture('missing-fx', w, h, theme);
      await go('/reports/flow?view=cash-forecast');
      await page
        .getByText(
          '信用卡缺少預估匯率，相關繳款未計入。請至信用卡與匯率設定確認。',
          { exact: true },
        )
        .waitFor();
      await capture('forecast', w, h, theme);
      await go('/investments?tab=deposits');
      await page.getByText('已到期 22 天，待處理', { exact: true }).waitFor();
      await capture('overdue-deposit', w, h, theme);
      await page.getByLabel('顯示已到期／已解約', { exact: true }).check();
      const settledCard = page.locator('.deposit-card').filter({
        has: page.getByRole('heading', {
          name: '合成已結清銀行',
          exact: true,
        }),
      });
      await settledCard.locator('summary').click();
      assert.equal(
        await settledCard
          .getByRole('button', { name: '撤銷入帳', exact: true })
          .count(),
        1,
      );
      await capture('settled-deposit', w, h, theme);
      await page.evaluate(
        (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
        empty.id,
      );
      await go('/');
      await page.getByRole('button', { name: '提醒，0 筆未讀' }).click();
      await page.getByRole('heading', { name: '目前沒有提醒' }).waitFor();
      await capture('empty', w, h, theme);
      await page.getByRole('button', { name: '關閉提醒中心' }).click();
      const endpoint = `**/api/ledgers/${empty.id}/reminders`;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const inFlight = [];
      const held = async (route) => {
        const promise = gate.then(() => route.continue());
        inFlight.push(promise);
        await promise;
      };
      await page.route(endpoint, held);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '提醒，0 筆未讀' }).click();
      await page
        .getByRole('dialog', { name: '提醒中心' })
        .getByRole('status', { name: '載入中' })
        .waitFor();
      await capture('loading', w, h, theme);
      release();
      await Promise.all(inFlight);
      await page.unroute(endpoint, held);
      await settle();
      await page.getByRole('button', { name: '關閉提醒中心' }).click();
      await page.route(endpoint, (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'synthetic_unavailable' }),
        }),
      );
      await page.reload();
      await page.getByRole('button', { name: '提醒，0 筆未讀' }).click();
      await page
        .getByRole('dialog', { name: '提醒中心' })
        .getByRole('button', { name: '重試' })
        .waitFor();
      await capture('error', w, h, theme);
      await page.unroute(endpoint);
      await page.getByRole('button', { name: '關閉提醒中心' }).click();
    }
  // Reappearing unread after content change and successful settings persistence.
  await page.evaluate(
    (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
    l.id,
  );
  await reminderService(db).markRead(actor, l.id, { all: true });
  await db`UPDATE fixed_deposits SET principal=1001 WHERE ledger_id=${l.id}`;
  await go('/');
  await page.getByRole('button', { name: '提醒，1 筆未讀' }).waitFor();
  assert.equal(
    (await reminderService(db).settings(actor, l.id)).deposit_days,
    7,
  );
  await db`INSERT INTO recurring_occurrences(ledger_id,source_rule_id,rule_name,occurs_on,occurred_on,template,status) SELECT ${l.id},gen_random_uuid(),'合成大量提醒',${today},${today},'{}'::jsonb,'pending' FROM generate_series(1,100)`;
  await go('/');
  const many = page.getByRole('button', { name: '提醒，101 筆未讀' });
  await many.waitFor();
  assert.equal(await many.locator('span').innerText(), '99+');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(states.length, 96);
  await writeFile(
    output + '/matrix.json',
    JSON.stringify(
      {
        synthetic: true,
        states,
        browserErrors: errors,
        externalRequests: external,
      },
      null,
      2,
    ),
  );
  console.log(
    'Reminders/foreign-card UX PASS 96 PNG; four sizes x two themes; axe0/overflow0/external0',
  );
} catch (e) {
  if (browser) {
    const p = browser.contexts()[0]?.pages()[0];
    if (p) {
      await p.screenshot({ path: output + '/failure.png' });
      await writeFile(
        output + '/failure.txt',
        await p.locator('body').innerText(),
      );
    }
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (discovery.listening) {
    discovery.close();
    await once(discovery, 'close');
  }
  if (db) await db.end();
}
