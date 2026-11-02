// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const read = (name) => readFileSync(`.github/workflows/${name}.yaml`, 'utf8');
const ci = read('ci'),
  release = read('release');
test('all workflows default to read-only and every action is immutable', () => {
  for (const file of readdirSync('.github/workflows')) {
    const source = readFileSync(`.github/workflows/${file}`, 'utf8');
    assert.match(source, /^permissions:\n {2}contents: read\n/m, file);
    assert.doesNotMatch(source, /pull_request_target/, file);
    for (const [, action] of source.matchAll(/uses: (\S+)/g))
      assert.match(action, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/, file);
  }
});
test('same PR cancellation is scoped to CI, never release', () => {
  assert.match(
    ci,
    /group: ci-\$\{\{ github.event.pull_request.number \|\| github.ref \}\}/,
  );
  assert.ok(
    ci.includes(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    ),
  );
  assert.doesNotMatch(release, /^concurrency:|cancel-in-progress: true/m);
});
test('full-only image and offline jobs, always-on final result gate', () => {
  for (const job of ['runtime-smoke'])
    assert.ok(
      ci.includes(
        `  ${job}:\n    needs: plan\n    if: needs.plan.outputs.full == 'true'`,
      ),
    );
  assert.match(ci, /ci-result:\n {4}if: always\(\)/);
  assert.match(
    ci,
    /types: \[opened, synchronize, reopened, labeled, unlabeled, ready_for_review\]/,
  );
  assert.match(ci, /tags: \['v\*'\]/);
  assert.match(ci, /workflow_dispatch:/);
});
test('pnpm/browser/build layers are lockfile-keyed; screenshots upload only on failure', () => {
  assert.match(ci, /cache-dependency-path: pnpm-lock.yaml/);
  assert.match(ci, /key: playwright-.*hashFiles\('pnpm-lock.yaml'\)/);
  for (const source of [ci, release]) {
    const lines = source
      .split('\n')
      .filter((line) => /cache-(from|to):/.test(line));
    assert.ok(lines.length);
    for (const line of lines)
      assert.match(line, /type=gha,scope=.*hashFiles\('pnpm-lock.yaml'\)/);
  }
  assert.match(
    ci,
    /Upload full UI evidence only on failure\n {8}if: failure\(\)/,
  );
  const uploads = ci
    .split(/- (?:name: [^\n]+\n[^]*?uses: )?actions\/upload-artifact@/)
    .slice(1);
  assert.equal(uploads.length, 3);
  for (const part of uploads)
    assert.match(part.split(/\n {6}- /)[0], /retention-days: 7/);
});
test('untrusted CI has no secrets; publication is tag-only with explicit secret step guards', () => {
  assert.doesNotMatch(
    ci,
    /packages: write|contents: write|pull-requests: write/,
  );
  assert.match(
    release,
    /publish:\n {4}if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/v'\)/,
  );
  for (const part of release
    .split(/\n {6}- /)
    .filter((step) => /secrets\./.test(step)))
    assert.match(
      part,
      /if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/v'\)/,
    );
});

function assertSecretScope(source) {
  const secretSteps = source
    .split(/\n {6}- /)
    .filter((step) => /secrets\./.test(step));
  assert.equal(secretSteps.length, 1);
  const [step] = secretSteps;
  assert.match(
    step,
    /^name: Environment identifier scan \(trusted repository only\)/,
  );
  assert.ok(
    step.includes(
      "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
    ),
  );
  assert.deepEqual(
    [...source.matchAll(/secrets\.([A-Z_]+)/g)].map((x) => x[1]),
    ['ENV_IDENTIFIER_PATTERNS'],
  );
  assert.match(
    step,
    /ENV_IDENTIFIER_PATTERNS: \$\{\{ secrets\.ENV_IDENTIFIER_PATTERNS \}\}/,
  );
}
test('private identifiers are exposed only to the guarded scan step', () => {
  assertSecretScope(ci);
  assert.throws(() =>
    assertSecretScope(
      ci.replace(
        'github.event.pull_request.head.repo.full_name == github.repository',
        'true',
      ),
    ),
  );
  assert.throws(() =>
    assertSecretScope(
      ci.replace(
        'name: Environment identifier scan (trusted repository only)',
        'name: Other step',
      ),
    ),
  );
  assert.throws(() =>
    assertSecretScope(ci + '\n  extra: ${{ secrets.OTHER_SECRET }}'),
  );
});
test('docs-only still runs every content gate; CI has no image vulnerability scans', () => {
  for (const name of [
    'Reject unexpected legacy product identifiers',
    'Environment identifier scan (trusted repository only)',
    'Synthetic data and file policy scan',
    'Secret scan (PR added diff or tracked tree)',
  ]) {
    const step = ci
      .split(/\n {6}- /)
      .find((step) => step.startsWith(`name: ${name}\n`));
    assert.ok(step, name);
    assert.doesNotMatch(step, /needs.plan.outputs.(?:docs|full)/);
  }
  assert.doesNotMatch(ci, /trivy|postgres-scan|container-scan/i);
  assert.match(ci, /needs: \[plan, check, db-integration, runtime-smoke\]/);
  assert.match(ci, /test "\$RUNTIME" = success/);
});
test('weekly reports include worker and history; release blocking thresholds remain', () => {
  const weekly = read('weekly-security');
  assert.match(weekly, /image-ref: finmichi-worker:weekly/);
  assert.match(weekly, /gitleaks.mjs --history --report-only/);
  assert.match(weekly, /fetch-depth: 0/);
  assert.match(release, /severity: HIGH,CRITICAL/);
  assert.match(release, /ignore-unfixed: true/);
  assert.match(release, /exit-code: '1'/);
});
