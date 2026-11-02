// SPDX-License-Identifier: AGPL-3.0-only
// Only synthetic export CSV + localhost services. No MDB or external network.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import {
  sessionService,
  securityService,
  securityReports,
} from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
import { readBundle } from '../tools/emoney-import/dist/bundle.js';
import { transform } from '../tools/emoney-import/dist/transform.js';
import { mappingSchema } from '../tools/emoney-import/dist/schema.js';
import { applyPlan } from '../tools/emoney-import/dist/import.js';
import { importInvestments } from '../tools/emoney-import/dist/investments.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const url = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  url.pathname !== '/synthetic'
)
  throw new Error('Local synthetic DB only');
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/ux-investment-import';
await mkdir(output, { recursive: true });
const subject = 'synthetic-investment-ui-' + Date.now(),
  issuer = 'https://' + subject + '.invalid',
  origin = 'https://localhost:18467';
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
  const sessions = sessionService(db, [subject]),
    token = await sessions.login(issuer, subject),
    actor = (await sessions.authenticate(token)).id;
  const bundle = await readBundle('tools/emoney-import/fixtures-investments'),
    mapping = JSON.parse(
      await readFile(
        'tools/emoney-import/investments.mapping.example.json',
        'utf8',
      ),
    );
  // The imported bank root has a live child: new app trades use its leaf.
  mapping.settlement_item = '活存';
  mapping.deposit_items[0].payout_account = '活存';
  const l = await applyPlan(
    db,
    transform(bundle, mappingSchema.parse({}), null),
    { ownerSubject: subject, ledgerName: '合成投資驗收' },
  );
  await importInvestments(db, bundle, mapping, {
    ownerSubject: subject,
    ledgerId: l.ledger_id,
    apply: true,
    now: new Date('2026-10-23T00:00:00Z'),
  });
  const [s] =
      await db`SELECT id FROM securities WHERE ledger_id=${l.ledger_id} AND symbol='00999'`,
    [t] =
      await db`SELECT settlement_item_id,expense_item_id,gain_item_id,trade_date::text FROM security_trades WHERE security_id=${s.id} ORDER BY trade_date LIMIT 1`;
  const data = {
    trade_type: 'buy',
    trade_date: '2026-01-10',
    quantity: '10',
    price: '20',
    fee: '0',
    tax: '0',
    settlement_item_id: t.settlement_item_id,
    expense_item_id: t.expense_item_id,
    gain_item_id: t.gain_item_id,
  };
  const svc = securityService(db),
    p = await svc.preview(actor, l.ledger_id, s.id, {
      operation: 'create',
      trade: data,
    });
  await svc.apply(actor, l.ledger_id, s.id, 'create', {
    trade: data,
    preview_hash: p.preview_hash,
    confirm_recalculation: true,
  });
  const before = JSON.stringify(
    await db`SELECT id,origin,transaction_id FROM security_trades WHERE ledger_id=${l.ledger_id} ORDER BY id`,
  );
  const positions = await securityReports(db).holdings(actor, l.ledger_id, {
    as_of: '2026-02-01',
  });
  assert.ok(positions.items.some((h) => h.origin === 'mixed'));
  assert.ok(positions.items.some((h) => h.origin === 'emoney'));
  app = await createApp(
    {
      databaseUrl,
      publicUrl: origin,
      issuer,
      clientId: 'synthetic',
      allowedSubjects: [subject],
      trustProxy: 0,
      version: 'test',
      mockInternalUrl: `http://127.0.0.1:${discovery.address().port}`,
      tlsKey: 'deploy/local/tls-key',
      tlsCert: 'deploy/local/tls-cert',
    },
    db,
  );
  await app.listen({ host: '127.0.0.1', port: 18467 });
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
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
  await context.addInitScript(
    (id) => globalThis.localStorage.setItem('finmichi-ledger', id),
    l.ledger_id,
  );
  const page = await context.newPage(),
    errors = [],
    external = [],
    states = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!['localhost', '127.0.0.1'].includes(new URL(r.url()).hostname))
      external.push(r.url());
  });
  async function go(path) {
    await page.goto(origin + path);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => globalThis.document.fonts.ready);
  }
  async function capture(state, w, h, theme) {
    // Includes dialogs and error banners; user-controlled names in this fixture are neutral.
    assert.doesNotMatch(
      await page.locator('body').innerText(),
      /E-Money|轉入|（混合）/,
      state,
    );

    assert.equal(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth,
      ),
      false,
      state,
    );
    // Audit the settled drawer, not intermediate opacity during its entrance transition.
    await page.evaluate(async () => {
      await Promise.all(
        globalThis.document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      );
    });
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    assert.deepEqual(axe.violations, [], state);
    const screenshot = `investments-${state}-${w}x${h}-${theme}.png`;
    await page.screenshot({ path: output + '/' + screenshot });
    states.push({
      state,
      width: w,
      height: h,
      theme,
      screenshot,
      horizontalOverflow: false,
      violations: [],
    });
  }
  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
    [360, 780],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await go('/investments?as_of=2026-02-01');
      await page.evaluate(
        (theme) => globalThis.localStorage.setItem('finmichi-theme', theme),
        theme,
      );
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.getByRole('link', { name: /00999/ }).first().waitFor();
      await capture('holdings', w, h, theme);
      await go(`/investments/${s.id}?as_of=2026-02-01`);
      await page.getByRole('heading', { name: '交易與股數紀錄' }).waitFor();
      await capture('history', w, h, theme);
      const edit = page
        .locator('.stock-history')
        .filter({ hasText: t.trade_date })
        .first()
        .getByRole('button');
      await edit.click();
      assert.equal(
        await page
          .getByRole('textbox', { name: '股票動作', exact: true })
          .isDisabled(),
        true,
      );
      await page.getByText('此紀錄不能改變類型', { exact: true }).waitFor();
      await capture('editor', w, h, theme);
      await page
        .getByRole('button', { name: '預覽股票分錄', exact: true })
        .click();
      await page.getByText('此動作不產生帳務分錄。', { exact: true }).waitFor();
      await page
        .getByText('此動作不產生帳務分錄。', { exact: true })
        .scrollIntoViewIfNeeded();
      await capture('preview', w, h, theme);
      await page.keyboard.press('Escape');
      await go(
        '/investments?view=realized-gains&date_from=2026-01-01&date_to=2026-02-01',
      );
      await page
        .getByRole('heading', { name: '已實現損益', exact: true })
        .waitFor();
      await page.getByText('未入帳', { exact: true }).first().waitFor();
      await capture('realized', w, h, theme);
    }
  assert.equal(
    JSON.stringify(
      await db`SELECT id,origin,transaction_id FROM security_trades WHERE ledger_id=${l.ledger_id} ORDER BY id`,
    ),
    before,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(states.length, 40);
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
    'Investments import UX PASS 40 PNG; 4 sizes x2 themes; holdings/history/nonbooking preview/realized; axe0/overflow0/external0',
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
