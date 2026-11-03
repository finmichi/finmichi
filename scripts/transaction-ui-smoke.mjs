// SPDX-License-Identifier: AGPL-3.0-only
import { revealItemOption } from './item-picker-test.mjs';
// Synthetic HTTP → browser → DB acceptance; never point at a real ledger DB.
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
const output = process.env.UI_OUTPUT_DIR ?? 'test-results/transactions';
await mkdir(output, { recursive: true });
const issuer = `https://transaction-ui-${Date.now()}.synthetic.invalid`;
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
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('https://localhost:18444/?entry=new');
  await page.getByRole('heading', { name: '快速記帳', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('heading', { name: '新增帳本', exact: true }).count(),
    0,
  );
  const home = await page
    .getByRole('heading', { name: '快速記帳', exact: true })
    .boundingBox();
  assert.ok(home && home.y < 500);
  await page.screenshot({
    path: output + '/mobile-quick-entry-home-390.png',
    fullPage: false,
  });
  await page.goto('https://localhost:18444/admin/ledgers');
  await page.getByRole('button', { name: '管理目前帳本', exact: true }).click();
  await page.getByRole('heading', { name: '編輯帳本', exact: true }).waitFor();
  await page.getByRole('button', { name: '關閉編輯', exact: true }).click();
  await page
    .getByRole('heading', { name: '編輯帳本', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(
    await page.getByRole('heading', { name: '編輯帳本', exact: true }).count(),
    0,
  );
  console.log(
    '390px entry route quick entry; separate ledger management drawer open/close PASS',
  );
  await page.goto('https://localhost:18444/?entry=new');
  const field = (name) =>
    page.getByRole('textbox', { name: new RegExp('^' + name) });
  async function select(label, name) {
    await field(label).click();
    await revealItemOption(page, name);
    await page.getByRole('option', { name, exact: true }).click();
  }
  async function openNew() {
    if (!(await page.locator('.entry-drawer-content').count())) {
      if (
        await page
          .getByRole('button', { name: '關閉通知', exact: true })
          .count()
      )
        await page
          .getByRole('button', { name: '關閉通知', exact: true })
          .click();
      await page.goto('https://localhost:18444/?entry=new');
      await page.waitForLoadState('networkidle');
    }
  }
  async function openEdit(id) {
    await page.goto('https://localhost:18444/?entry=' + id);
    await page.locator('.entry-preview').waitFor();
  }
  async function form(source, destination, amount, target) {
    await openNew();
    await page
      .locator('.entry-drawer-content')
      .getByText(destination.includes('費用') ? '支出' : '轉帳', {
        exact: true,
      })
      .click();
    await select('來源科目', source);
    await select('目的科目', destination);
    await field('來源金額').fill(amount);
    if (target) await field('目的金額').fill(target);
    await page.getByLabel('交易日期').fill('2026-10-17');
  }
  async function save() {
    await page.getByRole('button', { name: '試算交易', exact: true }).click();
    await page.getByRole('button', { name: '儲存交易', exact: true }).click();
    await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
    await page.getByText('交易已儲存。', { exact: true }).waitFor();
  }
  async function noOverflow() {
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth,
      ),
      false,
    );
  }
  await form('合成現金 (TWD)', '合成費用 (TWD)', '12.34');
  await page.getByRole('button', { name: '合成常用摘要', exact: true }).click();
  assert.equal(await field('摘要').inputValue(), '合成範本內容');
  await select('收付人', '合成收付人');
  await select('專案', '合成專案');
  await page
    .getByRole('button', { name: '發票與進階欄位', exact: true })
    .click();
  await field('發票號碼').fill('SYNTHETIC-01');
  await field('摘要').fill('合成手機 A');
  await save();
  let rows =
    await db`SELECT id,kind FROM transactions WHERE ledger_id=${ledger.id} AND memo='合成手機 A'`;
  assert.equal(rows[0].kind, 'expense');
  const metadata = (
    await db`SELECT payee_id,project_id,invoice_no FROM transactions WHERE id=${rows[0].id}`
  )[0];
  assert.equal(metadata.payee_id, payee.id);
  assert.equal(metadata.project_id, project.id);
  assert.equal(metadata.invoice_no, 'SYNTHETIC-01');
  console.log('390px quick A: HTTP create → DB PASS');
  await openEdit(rows[0].id);
  await field('摘要').fill('合成手機 A 修改');
  await save();
  assert.equal(
    (await db`SELECT memo FROM transactions WHERE id=${rows[0].id}`)[0].memo,
    '合成手機 A 修改',
  );
  console.log('390px quick update: PASS');
  await form('合成現金 (TWD)', '合成美元費用 (USD)', '4000', '100');
  await field('摘要').fill('合成手機 C');
  await page.getByRole('button', { name: '試算交易', exact: true }).click();
  await page.getByText(/有效匯率偏離參考匯率超過 5%/).waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: '儲存交易', exact: true })
      .isDisabled(),
    true,
  );
  assert.match(
    await page.locator('body').innerText(),
    /有效匯率 40\.0000(?!\d)/,
  );
  await noOverflow();
  await page.screenshot({
    path: output + '/quick-c-warning-390.png',
    fullPage: true,
  });
  await page
    .getByRole('checkbox', { name: '已確認匯率差異，仍要儲存', exact: true })
    .check();
  await page.getByRole('button', { name: '儲存交易', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  await page.getByText('交易已儲存。', { exact: true }).waitFor();
  rows =
    await db`SELECT e.amount::text,e.exchange_rate::text,e.base_amount::text FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id WHERE t.ledger_id=${ledger.id} AND t.memo='合成手機 C' ORDER BY e.entry_position`;
  assert.equal(rows[1].exchange_rate, '40.0000000000');
  assert.equal(rows[1].base_amount, '4000.000000');
  console.log('390px quick C, effective rate, >5% acknowledgement: PASS');
  await openEdit(
    (
      await db`SELECT id FROM transactions WHERE ledger_id=${ledger.id} AND memo='合成手機 C'`
    )[0].id,
  );
  // Start a new form to verify absence of an entry-supplied reference independently.
  await page.getByRole('button', { name: '關閉記帳', exact: true }).click();
  await form('合成美元資產 (USD)', '合成現金 (TWD)', '100', '4000');
  await page.getByLabel('交易日期').fill('2026-10-18');
  await field('USD → TWD 匯率').fill('32.5');
  await field('摘要').fill('合成 C 使用者參考');
  // Automatic and manual previews share an endpoint; match this form revision.
  const previewReply = (memo) =>
    page.waitForResponse((reply) => {
      const url = new URL(reply.url());
      return (
        url.origin === 'https://localhost:18444' &&
        url.pathname === `/api/ledgers/${ledger.id}/transactions/preview` &&
        reply.request().method() === 'POST' &&
        reply.request().postDataJSON().memo === memo
      );
    });
  let response = previewReply('合成 C 使用者參考');
  await page.getByRole('button', { name: '試算交易', exact: true }).click();
  let comparison = (await (await response).json()).fx_comparisons[0];
  assert.equal(comparison.reference_source, 'user_input');
  assert.equal(comparison.reference_rate, '32.5000000000');
  assert.equal(comparison.deviation_percent, '23.0769230769');
  await page.getByText(/有效匯率偏離參考匯率超過 5%/).waitFor();
  await page.getByText(/參考來源：使用者輸入/).waitFor();
  assert.match(await page.locator('body').innerText(), /偏差 23\.08%/);
  await noOverflow();
  await page.screenshot({
    path: output + '/c-user-reference-warning-390.png',
    fullPage: true,
  });
  await page
    .getByRole('checkbox', { name: '已確認匯率差異，仍要儲存', exact: true })
    .check();
  response = page.waitForResponse(
    (r) => r.url().endsWith('/transactions') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '儲存交易', exact: true }).click();
  const stored = await (await response).json();
  assert.equal(stored.fx_comparisons[0].reference_source, 'user_input');
  assert.equal(stored.fx_comparisons[0].effective_rate, '40.0000000000');
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  await page.getByText('交易已儲存。', { exact: true }).waitFor();
  console.log(
    'C USD -100 @32.5 / TWD4000 without daily rate: warning23.0769230769%, manual source, preview/save PASS',
  );
  await form('合成美元資產 (USD)', '合成現金 (TWD)', '100', '4000');
  await field('摘要').fill('合成 C 當日參考');
  response = previewReply('合成 C 當日參考');
  await page.getByRole('button', { name: '試算交易', exact: true }).click();
  comparison = (await (await response).json()).fx_comparisons[0];
  assert.equal(comparison.reference_source, 'exchange_rates');
  assert.equal(comparison.deviation_percent, '22.8237172598');
  await page.getByText(/參考來源：當日匯率/).waitFor();
  await page
    .getByRole('checkbox', { name: '已確認匯率差異，仍要儲存', exact: true })
    .check();
  await page.getByRole('button', { name: '儲存交易', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  await page.getByText('交易已儲存。', { exact: true }).waitFor();
  console.log('C daily reference only, no user rate: PASS');
  await form('合成美元資產 (USD)', '合成現金 (TWD)', '100', '3251');
  await page.getByLabel('交易日期').fill('2026-10-18');
  await field('USD → TWD 匯率').fill('32.5');
  await field('摘要').fill('合成 C 小幅偏差');
  response = previewReply('合成 C 小幅偏差');
  await page.getByRole('button', { name: '試算交易', exact: true }).click();
  const close = await (await response).json();
  assert.deepEqual(close.warnings, []);
  assert.equal(close.fx_comparisons[0].deviation_percent, '0.0307692308');
  await page.getByText(/偏差 0\.03%/).waitFor();
  assert.equal(
    await page
      .getByRole('checkbox', { name: '已確認匯率差異，仍要儲存', exact: true })
      .count(),
    0,
  );
  await page.getByRole('button', { name: '儲存交易', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  await page.getByText('交易已儲存。', { exact: true }).waitFor();
  console.log('C within5%, no warning, save allowed: PASS');
  await form('合成美元資產 (USD)', '合成現金 (TWD)', '100', '4000');
  await page.getByLabel('交易日期').fill('2026-10-18');
  await field('摘要').fill('合成 C 無參考');
  response = previewReply('合成 C 無參考');
  await page.getByRole('button', { name: '試算交易', exact: true }).click();
  const absent = await (await response).json();
  assert.deepEqual(absent.warnings, []);
  assert.equal(absent.fx_comparisons[0].reference_source, 'none');
  assert.equal(absent.fx_comparisons[0].deviation_percent, null);
  await page.getByText(/無參考匯率（不比較）/).waitFor();
  await page.getByRole('button', { name: '儲存交易', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  await page.getByText('交易已儲存。', { exact: true }).waitFor();
  console.log('C no reference: no comparison, save allowed PASS');

  await form('合成美元資產 (USD)', '合成美元費用 (USD)', '33.33');
  await field('摘要').fill('合成手機 BD');
  await save();
  rows =
    await db`SELECT e.base_amount::text FROM transaction_entries e JOIN transactions t ON t.id=e.transaction_id WHERE t.ledger_id=${ledger.id} AND t.memo='合成手機 BD' ORDER BY e.entry_position`;
  assert.deepEqual(
    rows.map((r) => r.base_amount),
    ['-1085.460000', '1085.460000'],
  );
  console.log('390px quick BD, dated reference: PASS');
  const bdTx = (
    await db`SELECT id FROM transactions WHERE ledger_id=${ledger.id} AND memo='合成手機 BD'`
  )[0];
  await openEdit(bdTx.id);
  await field('USD → TWD 匯率').fill('35');
  await save();
  await openEdit(bdTx.id);
  await field('摘要').fill('合成手機 BD 手改保留');
  await save();
  assert.equal(
    (
      await db`SELECT exchange_rate::text FROM transaction_entries WHERE transaction_id=${bdTx.id} ORDER BY entry_position`
    )[0].exchange_rate,
    '35.0000000000',
  );
  console.log('BD manual rate preserved across metadata edit: PASS');
  await openNew();
  await page.getByText('進階', { exact: true }).click();
  // Set the source date before manual rates; changing dates correctly clears overrides.
  await page.getByLabel('交易日期').fill('2026-10-17');
  await select('分錄 1 科目', '合成美元資產 (USD)');
  await field('分錄 1 金額').fill('0.005');
  await field('分錄 1 匯率').fill('1');
  await select('分錄 2 科目', '合成美元費用 (USD)');
  await field('分錄 2 金額').fill('0.005');
  await field('分錄 2 匯率').fill('1');
  await page.getByRole('button', { name: '新增分錄', exact: true }).click();
  await select('分錄 3 科目', '合成美元資產 (USD)');
  await field('分錄 3 金額').fill('-0.010');
  await field('分錄 3 匯率').fill('1');
  await field('摘要').fill('合成多分錄');
  await page.getByRole('button', { name: '試算交易', exact: true }).click();
  await page.getByText('本位幣 −NT$ 0.02', { exact: false }).waitFor();
  await noOverflow();
  await page.screenshot({
    path: output + '/advanced-residual-390.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '儲存交易', exact: true }).click();
  await page.locator('.entry-drawer-content').waitFor({ state: 'hidden' });
  await page.getByText('交易已儲存。', { exact: true }).waitFor();
  const advancedTx = (
    await db`SELECT id FROM transactions WHERE ledger_id=${ledger.id} AND memo='合成多分錄'`
  )[0];
  const oldEntries =
    await db`SELECT id,base_amount::text FROM transaction_entries WHERE transaction_id=${advancedTx.id} ORDER BY entry_position`;
  assert.deepEqual(
    oldEntries.map((e) => e.base_amount),
    ['0.010000', '0.010000', '-0.020000'],
  );
  await openEdit(advancedTx.id);
  await field('分錄 3 金額').waitFor();
  await page.getByRole('button', { name: '移除分錄 3', exact: true }).click();
  await field('分錄 1 金額').fill('-2');
  await field('分錄 2 金額').fill('2');
  await save();
  const replaced =
    await db`SELECT id,base_amount::text FROM transaction_entries WHERE transaction_id=${advancedTx.id} ORDER BY entry_position`;
  assert.deepEqual(
    replaced.map((e) => e.base_amount),
    ['-2.000000', '2.000000'],
  );
  assert.ok(replaced.every((e) => !oldEntries.some((old) => old.id === e.id)));
  console.log(
    '390px advanced BD rounding tie, create/edit/remove-leg/replacement: PASS',
  );
  await openNew();
  await page.getByText('進階', { exact: true }).click();
  await select('分錄 1 科目', '合成美元資產 (USD)');
  await select('分錄 2 科目', '合成美元費用 (USD)');
  await field('分錄 1 匯率').fill('1');
  await field('分錄 2 匯率').fill('1');
  for (const [a, b, message] of [
    ['0.000001', '-0.000001', '金額換算成本位幣後為 0'],
    ['1', '1', '匯兌尾差超過可分攤範圍'],
  ]) {
    await field('分錄 1 金額').fill(a);
    await field('分錄 2 金額').fill(b);
    await page.getByRole('button', { name: '試算交易', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: message }).waitFor();
  }
  await select('分錄 1 科目', '合成現金 (TWD)');
  await select('分錄 2 科目', '合成費用 (TWD)');
  await field('分錄 1 金額').fill('-1');
  await field('分錄 2 金額').fill('2');
  await page.getByRole('button', { name: '試算交易', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: '本位幣借貸尚未平衡' })
    .waitFor();
  console.log('Advanced monetary error codes shown in Chinese (3): PASS');
  await namedRecordService(db, 'payees').update(actor, ledger.id, payee.id, {
    archived: true,
  });
  await namedRecordService(db, 'projects').update(
    actor,
    ledger.id,
    project.id,
    { archived: true },
  );
  await items.update(actor, ledger.id, usdExpense.id, { archived: true });
  await page.reload();
  await page.goto('https://localhost:18444/?entry=new');
  await openEdit(advancedTx.id);
  await page
    .getByText('這筆交易含封存科目，可修改日期、摘要等欄位；原分錄保留。', {
      exact: true,
    })
    .waitFor();
  await field('摘要').fill('合成封存保留');
  await save();
  assert.deepEqual(
    (
      await db`SELECT amount::text FROM transaction_entries WHERE transaction_id=${advancedTx.id} ORDER BY entry_position`
    ).map((e) => e.amount),
    ['-2.000000', '2.000000'],
  );
  await openEdit(advancedTx.id);
  await page.getByRole('button', { name: '刪除交易', exact: true }).click();
  await page.getByRole('button', { name: '確認刪除交易', exact: true }).click();
  await page.getByText('交易與所有分錄已刪除。', { exact: true }).waitFor();
  assert.equal(
    (
      await db`SELECT id FROM transaction_entries WHERE transaction_id=${advancedTx.id}`
    ).length,
    0,
  );
  console.log('Archived history metadata edit and cascade delete: PASS');
  const aTx = (
    await db`SELECT id FROM transactions WHERE ledger_id=${ledger.id} AND memo='合成手機 A 修改'`
  )[0];
  await openEdit(aTx.id);
  await field('摘要').fill('合成封存收付人專案保留');
  await save();
  assert.equal(
    (await db`SELECT payee_id FROM transactions WHERE id=${aTx.id}`)[0]
      .payee_id,
    payee.id,
  );
  console.log(
    'Archived payee/project unchanged references in edit preview: PASS',
  );
  await noOverflow();
  await page.screenshot({
    path: output + '/quick-transactions-390.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await noOverflow();
  await page.screenshot({
    path: output + '/quick-transactions-desktop.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    '390px / desktop: no horizontal overflow; browser errors 0; screenshots saved',
  );
  // Keep fixtures referenced so both selected item identities are checked by SQL FKs.
  assert.ok(cash.id && expense.id && usd.id && usdExpense.id);
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (discovery.listening) {
    discovery.close();
    await once(discovery, 'close');
  }
  if (db) await db.end();
}
