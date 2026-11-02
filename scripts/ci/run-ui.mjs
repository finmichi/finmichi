// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { allSuites } from './plan.mjs';
const suites = JSON.parse(process.env.CI_UI_SUITES ?? '[]');
if (
  !Array.isArray(suites) ||
  new Set(suites).size !== suites.length ||
  suites.some((suite) => !allSuites.includes(suite))
)
  throw new Error('Invalid UI suite selection');
mkdirSync('test-results', { recursive: true });
const results = [];
for (const suite of suites) {
  const start = Date.now();
  const result = spawnSync('pnpm', [`test:${suite}`], { stdio: 'inherit' });
  results.push({
    suite,
    seconds: (Date.now() - start) / 1000,
    status: result.status,
  });
  writeFileSync(
    'test-results/ci-ui-timing.json',
    JSON.stringify(results, null, 2),
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
