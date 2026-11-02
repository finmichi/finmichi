// SPDX-License-Identifier: AGPL-3.0-only
import { revealItemOption } from './item-picker-test.mjs';
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
} from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const u = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1'].includes(u.hostname) ||
  !['/synthetic', '/life_test'].includes(u.pathname)
)
  throw new Error('Local synthetic DB only');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-deposits';
await mkdir(output, { recursive: true });
const issuer = `https://deposits-${Date.now()}.synthetic.invalid`,
  origin = 'https://localhost:18452';
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
  const l = await ledgerService(db).create(actor, { name: '合成定存驗收' });
  const empty = await ledgerService(db).create(actor, { name: '合成空定存' });
  const mk = (name, kind, currency = 'TWD') =>
    itemService(db).create(actor, l.id, {
      name,
      kind,
      currency,
      non_operating: kind === 'income',
    });
  const deposit = await mk('合成定存科目', 'asset'),
    bank = await mk('合成撥入銀行', 'asset'),
    income = await mk('合成利息收入', 'income');
  await mk('稅費', 'expense');
  const usd = await mk('合成美元定存', 'asset', 'USD'),
    usdBank = await mk('合成美元銀行', 'asset', 'USD');
  const svc = depositService(db),
    config = {
      item_id: deposit.id,
      bank: '合成月付銀行',
      principal: '1000',
      annual_rate: '12',
      start_on: '2026-01-31',
      maturity_on: '2027-01-31',
      interest_basis: 'monthly',
      payout: 'monthly',
      payout_account_id: bank.id,
      interest_item_id: income.id,
    };
  await svc.save(actor, l.id, config);
  await svc.save(actor, l.id, {
    ...config,
    item_id: usd.id,
    payout_account_id: usdBank.id,
    bank: '合成美元銀行',
    payout: 'at_maturity',
  });
  await svc.save(actor, l.id, {
    ...config,
    bank: '合成零息銀行',
    annual_rate: '0',
    auto_renew: true,
    payout: 'at_maturity',
  });
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
  await app.listen({ host: '127.0.0.1', port: 18452 });
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
    const screenshot = `deposits-${state}-${w}x${h}-${theme}.png`;
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
  const pick = async (label, value) => {
    await page
      .getByRole('textbox', {
        name: new RegExp(
          '^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?: \\*)?$',
        ),
      })
      .click();
    await revealItemOption(page, value);
    await page.getByRole('option', { name: value, exact: true }).click();
  };

  const card = (bankName) =>
    page.locator('.deposit-card').filter({
      has: page.getByRole('heading', { name: bankName, exact: true }),
    });
  await go('/investments?tab=deposits');
  await card('合成月付銀行').waitFor();
  await page.getByRole('button', { name: '新增定存', exact: true }).click();
  await page.getByRole('textbox', { name: /^銀行/ }).fill('合成新增定存');
  await pick('定存科目', '合成定存科目 (TWD)');
  await pick('撥入帳戶', '合成撥入銀行 (TWD)');
  await page.getByRole('textbox', { name: /^本金/ }).fill('1000');
  await page.getByLabel('年利率（%）', { exact: false }).fill('12');
  await page.getByLabel('起存日', { exact: false }).fill('2026-01-31');
  await page.getByLabel('到期日', { exact: false }).fill('2026-02-28');
  await page.getByRole('button', { name: '儲存設定', exact: true }).click();
  await card('合成新增定存').waitFor();
  assert.equal(
    (
      await db`SELECT count(*)::int n FROM transactions WHERE ledger_id=${l.id}`
    )[0].n,
    0,
  );
  await card('合成新增定存')
    .getByRole('button', { name: '到期處理', exact: true })
    .click();
  await page.getByRole('button', { name: '預覽分錄', exact: true }).click();
  await page.getByRole('region', { name: '定存分錄預覽' }).waitFor();
  assert.match(
    await page.getByRole('region', { name: '定存分錄預覽' }).innerText(),
    /1,010.00/,
  );
  await page.getByRole('button', { name: '確認入帳', exact: true }).click();
  await settle();
  await page.getByLabel('顯示已到期／已解約').check();
  await card('合成新增定存').waitFor();
  await card('合成新增定存').locator('summary').click();
  await card('合成新增定存')
    .getByRole('button', { name: '撤銷入帳', exact: true })
    .click();
  const revoked = page.waitForResponse(
    (r) => r.request().method() === 'DELETE' && r.url().includes('/postings/'),
  );
  await page
    .getByRole('dialog', { name: '撤銷定存入帳' })
    .getByRole('button', { name: '撤銷入帳', exact: true })
    .click();
  assert.equal((await revoked).status(), 200);
  await page
    .getByRole('dialog', { name: '撤銷定存入帳' })
    .waitFor({ state: 'hidden' });
  await settle();
  assert.equal(
    (
      await db`SELECT count(*)::int n FROM transactions WHERE ledger_id=${l.id}`
    )[0].n,
    0,
  );
  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.evaluate(
        (t) => globalThis.localStorage.setItem('finmichi-theme', t),
        theme,
      );
      await page.reload();
      await settle();
      await card('合成月付銀行').waitFor();
      await capture('list', w, h, theme);
      await card('合成月付銀行').locator('summary').click();
      await capture('schedule', w, h, theme);
      await page
        .getByRole('button', { name: '入帳 合成月付銀行 第 1 期', exact: true })
        .click();
      await page.getByLabel('應發利息', { exact: true }).fill('9');
      await page.getByRole('button', { name: '預覽分錄', exact: true }).click();
      await page.getByRole('region', { name: '定存分錄預覽' }).waitFor();
      await capture('interest-preview', w, h, theme);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: '捨棄未儲存變更' }).waitFor();
      await capture('dirty', w, h, theme);
      await page.getByRole('button', { name: '捨棄變更', exact: true }).click();
      await settle();
      await card('合成月付銀行')
        .getByRole('button', { name: '到期處理', exact: true })
        .click();
      await pick('到期處理方式', '本金與實發利息續存');
      await page.getByRole('button', { name: '預覽分錄', exact: true }).click();
      await page.getByRole('region', { name: '定存分錄預覽' }).waitFor();
      await capture('renew-preview', w, h, theme);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '捨棄變更', exact: true }).click();
      await settle();
      await card('合成零息銀行')
        .getByRole('button', { name: '到期處理', exact: true })
        .click();
      await page.getByRole('button', { name: '預覽分錄', exact: true }).click();
      await page
        .getByText('零額處理：只記錄已處理期別，不建立交易。', { exact: true })
        .waitFor();
      await capture('zero-preview', w, h, theme);
      await page.keyboard.press('Escape');
      await settle();
      await card('合成美元銀行')
        .getByRole('button', { name: '到期處理', exact: true })
        .click();
      await page.getByLabel('匯率（留空使用參考匯率）').fill('32.5');
      await page.getByRole('button', { name: '預覽分錄', exact: true }).click();
      await page.getByRole('region', { name: '定存分錄預覽' }).waitFor();
      await capture('foreign-preview', w, h, theme);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '捨棄變更', exact: true }).click();
      await settle();
      await page.getByRole('button', { name: '新增定存', exact: true }).click();
      await capture('editor', w, h, theme);
      await page.keyboard.press('Escape');
      await settle();
      await page.evaluate(
        (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
        empty.id,
      );
      await page.reload();
      await page.getByRole('heading', { name: '尚無存續中的定存' }).waitFor();
      await capture('empty', w, h, theme);
      const endpoint = `**/api/ledgers/${empty.id}/deposits`;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(endpoint, async (route) => {
        await gate;
        await route.continue();
      });
      await page.reload();
      await page.getByRole('status', { name: '載入定存' }).waitFor();
      await capture('loading', w, h, theme);
      release();
      await page.getByRole('heading', { name: '尚無存續中的定存' }).waitFor();
      await page.unroute(endpoint);
      await page.route(endpoint, (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'internal_error' }),
        }),
      );
      await page.reload();
      await page.getByRole('alert').waitFor();
      await capture('error', w, h, theme);
      await page.unroute(endpoint);
      await page.getByRole('button', { name: '重試', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'hidden' });

      await page.evaluate(
        (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
        l.id,
      );
      await page.reload();
      await settle();
    }
  await go('/investments?tab=dividends');
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'dividends');
  await page.getByRole('button', { name: '定存', exact: true }).click();
  await page.waitForURL('**?tab=deposits');
  await card('合成月付銀行').waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(states.length, 88);
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
    'Deposits UX PASS 88 PNG; 4 sizes x2 themes; settings/interest/settlement/revoke/renewal/zero/foreign/dirty/empty/tab; axe0/overflow0/external0',
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
