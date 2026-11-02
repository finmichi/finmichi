// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// This allowlist is also the only input accepted by run-ui.mjs. Never execute a
// command supplied by an event, filename, PR title, or label.
export const allSuites = [
  'ux-investment-import',
  'ux-scroll-chaining',
  'ux-entry-scroll',
  'ux-reminders',
  'ux-deposits',
  'ux-dividends',
  'ux-stocks',
  'ux-market',
  'ux-mcp-drafts',
  'ux-finance',
  'ux-cash-forecast',
  'ui',
  'query-ui',
  'report-ui',
  'life2023-ui',
  'backup-ui',
  'audit-ui',
  'pat-ui',
  'ux-foundations',
  'ux-daily',
  'ux-entry',
  'ux-reports',
  'ux-admin',
  'ux-recurring',
  'ux-budget',
  'ux-report-extensions',
];
export const representativeSuites = [
  'ux-foundations',
  'ux-daily',
  'ux-entry',
  'ux-admin',
  'ux-reports',
];
const groups = [
  [/finance/, ['ux-finance', 'ux-cash-forecast']],
  [/cash-forecast|forecast-chart/, ['ux-cash-forecast']],
  [
    /investment|holding|stock|realized-gains/,
    ['ux-stocks', 'ux-investment-import'],
  ],
  [/dividend|income-codes/, ['ux-dividends']],
  [/deposit/, ['ux-deposits', 'ux-cash-forecast']],
  [/reminder/, ['ux-reminders']],
  [/market/, ['ux-market']],
  [/draft/, ['ux-mcp-drafts']],
  [/budget/, ['ux-budget']],
  [/recurring/, ['ux-recurring']],
  [/extended-report|flow-chart/, ['ux-report-extensions']],
  [/report/, ['report-ui', 'ux-reports', 'ux-report-extensions', 'ux-budget']],
  [
    /query|transaction-list|query-profit|daily|overview/,
    ['query-ui', 'ux-daily'],
  ],
  [
    /transaction|advanced-entr|entry|inline-create/,
    ['ui', 'ux-entry', 'ux-entry-scroll'],
  ],
  [/backup/, ['backup-ui']],
  [/life2023|import-page/, ['life2023-ui']],
  [/audit/, ['audit-ui']],
  [/pat/, ['pat-ui']],
  [/ledger|item|named-record|admin|system-page/, ['ux-admin']],
  [/scroll/, ['ux-scroll-chaining', 'ux-entry-scroll']],
];
const isDoc = (path) => path.endsWith('.md') || path.startsWith('docs/');

export function planCI({ event, ref = '', labels = [], paths = [] }) {
  const full =
    event === 'workflow_dispatch' ||
    event === 'release' ||
    (event === 'push' &&
      (ref === 'refs/heads/main' || ref.startsWith('refs/tags/v'))) ||
    (event === 'pull_request' && labels.includes('full-ci'));
  if (full)
    return { mode: 'full', full: true, docsOnly: false, suites: allSuites };
  if (event !== 'pull_request') throw new Error('Unsupported CI event');
  if (paths.length && paths.every(isDoc))
    return { mode: 'docs', full: false, docsOnly: true, suites: [] };
  const suites = new Set();
  for (const path of paths.filter((path) => !isDoc(path))) {
    // Unknown/shared files fail conservatively to representative journeys. The
    // complete 26-suite matrix requires one of the explicit full-CI triggers.
    const matched =
      path.startsWith('apps/web/src/') || path.startsWith('scripts/')
        ? groups.filter(([pattern]) => pattern.test(path))
        : [];
    if (!matched.length)
      representativeSuites.forEach((suite) => suites.add(suite));
    else
      matched.forEach(([, values]) =>
        values.forEach((suite) => suites.add(suite)),
      );
  }
  if (!paths.length) representativeSuites.forEach((suite) => suites.add(suite));
  return {
    mode: 'selected',
    full: false,
    docsOnly: false,
    suites: allSuites.filter((suite) => suites.has(suite)),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let paths = [];
  if (process.env.CI_EVENT === 'pull_request') {
    const { CI_BASE_SHA: base, CI_HEAD_SHA: head } = process.env;
    if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? '')))
      throw new Error('Expected immutable PR base/head SHA');
    // No API pagination/truncation; include both sides of renames/deletions.
    paths = execFileSync(
      'git',
      ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`],
      { encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean);
  }
  const plan = planCI({
    event: process.env.CI_EVENT,
    ref: process.env.CI_REF,
    labels: JSON.parse(process.env.CI_LABELS || '[]'),
    paths,
  });
  console.log(JSON.stringify(plan));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `full=${plan.full}\ndocs=${plan.docsOnly}\nsuites=${JSON.stringify(plan.suites)}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## CI selection\nMode: ${plan.mode}\nBase: ${process.env.CI_BASE_SHA || 'n/a'}\nHead: ${process.env.CI_HEAD_SHA || process.env.GITHUB_SHA}\n\nSuites: ${plan.suites.join(', ') || 'none (lint/format and content security scans)'}\n`,
    );
}
