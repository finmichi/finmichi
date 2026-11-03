// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { connect, migrate } from '../packages/db/dist/index.js';
import { sessionService, ledgerService } from '../packages/core/dist/index.js';
import { createApp } from '../apps/server/dist/app.js';
import { seedPastProject, seedProjects } from './project-report-fixture.mjs';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
const target = new URL(databaseUrl);
if (
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !['/synthetic', '/life_test'].includes(target.pathname)
)
  throw new Error('Synthetic localhost DB only');
const output =
  process.env.PROJECT_UI_OUTPUT_DIR ?? 'test-results/project-reports';
await mkdir(output, { recursive: true });
const issuer = `https://project-ui-${Date.now()}.synthetic.invalid`,
  origin = 'http://127.0.0.1:18449';
const discovery = createServer((_, res) => {
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
const results = [],
  errors = [],
  external = [];
try {
  discovery.listen(0, '127.0.0.1');
  await once(discovery, 'listening');
  db = connect(databaseUrl);
  await migrate(db);
  const sessions = sessionService(db, ['synthetic-owner']),
    token = await sessions.login(issuer, 'synthetic-owner'),
    actor = (await sessions.authenticate(token)).id;
  const ledger = await ledgerService(db).create(actor, {
      name: '合成專案分析驗收',
    }),
    ids = await seedProjects(db, actor, ledger.id);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const pastYear = Number(today.slice(0, 4)) - 1;
  const past = await seedPastProject(db, actor, ledger.id, ids.ids, pastYear);
  app = await createApp(
    {
      databaseUrl,
      publicUrl: origin,
      issuer,
      clientId: 'synthetic',
      allowedSubjects: ['synthetic-owner'],
      trustProxy: 0,
      version: 'synthetic',
      mockInternalUrl: `http://127.0.0.1:${discovery.address().port}`,
    },
    db,
  );
  await app.listen({ host: '127.0.0.1', port: 18449 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {}),
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: 'session',
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname))
      external.push(u.origin);
  });
  const dates = 'date_from=2026-09-01&date_to=2026-10-31';
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.goto(
        origin +
          '/reports/projects?' +
          dates +
          '&project=' +
          ids.trip +
          '&owner_id=ignored',
      );
      await page
        .getByRole('heading', { name: '專案分析：合成跨月旅遊', exact: true })
        .waitFor();
      await page.getByLabel('主題', { exact: true }).selectOption(theme);
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => globalThis.document.fonts.ready);
      const details = page.getByRole('region', {
        name: '分析 合成跨月旅遊',
        exact: true,
      });
      await details.getByText('NT$ 174.29', { exact: true }).waitFor();
      await details
        .getByRole('img', { name: '支出組成', exact: true })
        .waitFor();
      await details
        .getByRole('img', { name: '每月收支趨勢', exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: '分析 合成封存旅遊', exact: true })
          .count(),
        0,
      );
      const tree = page.locator('details[aria-label="科目明細 合成跨月旅遊"]');
      await tree.locator('summary').click();
      await tree.getByText('旅程支出', { exact: true }).waitFor();
      const overflow = await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth,
      );
      assert.equal(overflow, false);
      const axe = await new AxeBuilder({ page })
        .withRules(['color-contrast'])
        .analyze();
      assert.equal(axe.violations.length, 0, JSON.stringify(axe.violations));
      const chartThemes = await page
        .locator('[data-chart-theme]')
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute('data-chart-theme')),
        );
      assert(chartThemes.length >= 2 && chartThemes.every((v) => v === theme));
      await page
        .locator('#main-content')
        .evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({
        path: `${output}/${width}-${theme}-projects.png`,
        fullPage: true,
      });
      await details.evaluate((el) =>
        el.scrollIntoView({ block: 'start', behavior: 'instant' }),
      );
      const detailAxe = await new AxeBuilder({ page })
        .withRules(['color-contrast'])
        .analyze();
      assert.equal(
        detailAxe.violations.length,
        0,
        JSON.stringify(detailAxe.violations),
      );
      await page.screenshot({
        path: `${output}/${width}-${theme}-detail.png`,
        fullPage: true,
      });
      await details
        .getByRole('img', { name: '每月收支趨勢', exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${output}/${width}-${theme}-trend.png`,
        fullPage: true,
      });
      await page
        .getByRole('button', { name: '查看交易 合成跨月旅遊', exact: true })
        .click();
      await page.waitForURL('**/transactions?**');
      assert.equal(
        new URL(page.url()).searchParams.get('project_id'),
        ids.trip,
      );
      await page.getByText('共 6 筆', { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('textbox', { name: '篩選專案', exact: true })
          .isVisible(),
        true,
      );
      if (width < 900)
        await page.getByRole('button', { name: /篩選與工具/ }).click();
      await page.getByText('彙總', { exact: true }).click();
      await page
        .getByRole('textbox', { name: '彙總方式', exact: true })
        .click();
      await page.getByRole('option', { name: '依專案', exact: true }).click();
      if (width < 900)
        await page
          .getByRole('button', { name: '關閉篩選與工具', exact: true })
          .click();
      await page.getByText(/6 筆，交易金額 NT\$ 1,570\.00/).waitFor();
      for (const [report, label] of [
        ['income-summary', '收支專案'],
        ['category-statistics', '分類專案'],
      ]) {
        await page.goto(
          origin +
            '/reports/' +
            report +
            '?' +
            dates +
            '&' +
            (report === 'income-summary' ? 'grain=month' : 'kind=expense') +
            '&project_id=' +
            ids.trip,
        );
        // The select mounts before its independently fetched project options.
        await page.waitForFunction(
          (input) => input.value === '合成跨月旅遊',
          await page
            .getByRole('textbox', { name: label, exact: true })
            .elementHandle(),
        );
        assert.equal(
          await page
            .getByRole('textbox', { name: label, exact: true })
            .inputValue(),
          '合成跨月旅遊',
        );
        await page
          .getByText(width < 900 ? 'NT$ 1,220' : 'NT$ 1,220.00', {
            exact: true,
          })
          .first()
          .waitFor();
      }
      await page.goto(origin + '/reports/projects?' + dates);
      await page
        .getByRole('button', { name: '分析 合成空白專案', exact: true })
        .waitFor();
      await page
        .getByRole('checkbox', { name: '顯示已封存專案', exact: true })
        .check();
      await page.getByRole('button', { name: '產生報表', exact: true }).click();
      await page
        .getByRole('button', { name: '分析 合成封存旅遊', exact: true })
        .waitFor();
      assert.equal(
        new URL(page.url()).searchParams.get('include_archived'),
        'true',
      );
      // FB-029: no explicit dates, list link, explicit override, empty project,
      // and ledger-wide dates (including an older unassigned transaction).
      await page.goto(origin + '/reports/projects?project=' + past);
      await page.waitForFunction(
        ({ from, to }) => {
          const inputs = [
            ...globalThis.document.querySelectorAll('input[type="date"]'),
          ];
          return inputs[0]?.value === from && inputs[1]?.value === to;
        },
        { from: `${pastYear}-04-10`, to: `${pastYear}-04-12` },
      );
      await page
        .getByRole('region', { name: '分析 合成去年旅遊', exact: true })
        .getByText('NT$ 266.67', { exact: true })
        .waitFor();
      await page.goto(origin + '/reports/projects');
      await page
        .getByRole('button', { name: '分析 合成去年旅遊', exact: true })
        .click();
      assert.equal(new URL(page.url()).searchParams.has('date_from'), false);
      await page
        .getByRole('region', { name: '分析 合成去年旅遊', exact: true })
        .getByText('NT$ 266.67', { exact: true })
        .waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth,
        ),
        false,
      );
      const pastAxe = await new AxeBuilder({ page })
        .withRules(['color-contrast'])
        .analyze();
      assert.equal(
        pastAxe.violations.length,
        0,
        JSON.stringify(pastAxe.violations),
      );
      await page.screenshot({
        path: `${output}/${width}-${theme}-past-project.png`,
        fullPage: true,
      });
      await page.goto(
        origin + '/reports/projects?' + dates + '&project=' + past,
      );
      await page
        .getByRole('region', { name: '分析 合成去年旅遊', exact: true })
        .getByText('0', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel('期間起', { exact: true }).inputValue(),
        '2026-09-01',
      );
      assert.equal(
        await page.getByLabel('期間訖', { exact: true }).inputValue(),
        '2026-10-31',
      );
      await page.getByRole('button', { name: '全部期間', exact: true }).click();
      await page.waitForURL(
        (u) => u.searchParams.get('date_from') === `${pastYear - 1}-02-01`,
      );
      assert.equal(new URL(page.url()).searchParams.get('date_to'), today);
      await page
        .getByRole('region', { name: '分析 合成去年旅遊', exact: true })
        .getByText('NT$ 266.67', { exact: true })
        .waitFor();
      await page.waitForLoadState('networkidle');
      await page.screenshot({
        path: `${output}/${width}-${theme}-all-periods.png`,
        fullPage: true,
      });
      await page.goto(origin + '/reports/projects?project=' + ids.empty);
      await page
        .getByRole('heading', { name: '專案分析：合成空白專案', exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel('期間起', { exact: true }).inputValue(),
        today.slice(0, 4) + '-01-01',
      );
      results.push({
        width,
        height,
        theme,
        overflow,
        contrast: axe.violations.length,
        chartThemes,
        links: true,
        projectFilters: true,
        archived: true,
        historicalDefaults: true,
        explicitDates: true,
        allPeriods: true,
        emptyFallback: true,
      });
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(
    output + '/results.json',
    JSON.stringify({ results, errors, external }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      projectReportUi: 'PASS',
      states: results.length,
      overflow: 0,
      contrast: 0,
      errors,
      external,
    }),
  );
} finally {
  await browser?.close();
  await app?.close();
  discovery.close();
  await db?.end();
}
