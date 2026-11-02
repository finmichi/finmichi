// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allSuites, representativeSuites, planCI } from './plan.mjs';
const pr = (paths, labels = []) =>
  planCI({ event: 'pull_request', paths, labels });
test('docs-only includes root/nested Markdown and docs directory', () => {
  assert.equal(
    pr(['README.md', 'apps/web/README.md', 'docs/example.json']).docsOnly,
    true,
  );
  assert.deepEqual(pr(['README.md']).suites, []);
});
test('finance changes select only finance journeys; docs do not broaden them', () => {
  assert.deepEqual(pr(['apps/web/src/finance.tsx', 'README.md']).suites, [
    'ux-finance',
    'ux-cash-forecast',
  ]);
});
test('mixed changes union relevant journeys', () => {
  assert.deepEqual(
    pr(['apps/web/src/dividends.tsx', 'apps/web/src/finance-payments.ts'])
      .suites,
    ['ux-dividends', 'ux-finance', 'ux-cash-forecast'],
  );
});
test('unknown, shared, backend, dependency and workflow paths retain representative coverage', () => {
  for (const path of [
    'apps/web/src/new-view.tsx',
    'apps/web/src/design/theme.ts',
    'apps/server/src/app.ts',
    'packages/core/src/money.ts',
    'pnpm-lock.yaml',
    '.github/workflows/ci.yaml',
  ])
    assert.deepEqual(new Set(pr([path]).suites), new Set(representativeSuites));
  assert.ok(pr([]).suites.length);
});
test('full-ci overrides docs-only; removing label restores selection', () => {
  assert.deepEqual(pr(['README.md'], ['full-ci']).suites, allSuites);
  assert.equal(pr(['README.md'], ['unrelated']).mode, 'docs');
});
test('main/tag/release/manual run all suites even when paths are empty', () => {
  for (const args of [
    { event: 'push', ref: 'refs/heads/main' },
    { event: 'push', ref: 'refs/tags/v0.2.2' },
    { event: 'release' },
    { event: 'workflow_dispatch' },
  ])
    assert.deepEqual(planCI(args).suites, allSuites);
});
test('unsupported events cannot become a privileged/full pipeline', () => {
  for (const event of ['pull_request_target', 'workflow_run', 'issue_comment'])
    assert.throws(() => planCI({ event }));
});
test('full list matches every existing UI package script, no omissions/unknown commands', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  const actual = Object.entries(scripts)
    .filter(([, command]) => /scripts\/(?:ux-|.*ui-smoke)/.test(command))
    .map(([key]) => key.slice(5));
  assert.deepEqual(new Set(allSuites), new Set(actual));
});
