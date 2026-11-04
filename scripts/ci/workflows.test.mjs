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

function releaseStep(name) {
  const step = release
    .split(/\n {6}- /)
    .find((part) => part.startsWith(`name: ${name}\n`));
  assert.ok(step, name);
  return step;
}
function shellBlock(step) {
  return step.split('        run: |\n')[1].replace(/^ {10}/gm, '');
}

// Execute the workflow's real shell policy against synthetic API responses only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function visibilityResult(
  script,
  { visibility, error = '', first404 = false },
) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-visibility-'));
  try {
    return spawnSync(
      'bash',
      [
        '-euo',
        'pipefail',
        '-c',
        `calls=0
        gh() {
          calls=$((calls + 1))
          if [ "$MOCK_FIRST_404" = true ] && [ "$calls" = 1 ]; then
            echo 'HTTP 404' >&2; return 1
          fi
          if [ -n "$MOCK_ERROR" ]; then echo "$MOCK_ERROR" >&2; return 1; fi
          printf '%s\\n' "$MOCK_JSON"
        }
        sleep() { :; }
        package=finmichi
        ${script}
        printf '%s' "\${visibility:-missing}"
        `,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          MOCK_JSON: JSON.stringify({ visibility }),
          MOCK_ERROR: error,
          MOCK_FIRST_404: String(first404),
        },
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('release pre/post checks allow only private/public, fail closed and retain 404 handling', () => {
  const before = shellBlock(
    releaseStep('Require supported package visibility'),
  );
  const publish = shellBlock(
    releaseStep('Publish all scanned amd64 images with one tag'),
  );
  const after = publish.slice(
    publish.indexOf("  visibility=''"),
    publish.indexOf('  digest='),
  );
  assert.match(after, /for _attempt in 1 2 3/);
  for (const script of [before, after]) {
    for (const visibility of ['private', 'public']) {
      const result = visibilityResult(script, { visibility });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, visibility);
    }
    for (const visibility of ['internal', '', 'PUBLIC', null, undefined]) {
      const result = visibilityResult(script, { visibility });
      assert.notEqual(result.status, 0, String(visibility));
    }
    for (const error of ['HTTP 403', 'HTTP 500', 'connection failed']) {
      assert.notEqual(visibilityResult(script, { error }).status, 0, error);
    }
  }
  // A not-yet-created package is allowed before the first push; after push it
  // must become readable within the existing three-attempt propagation window.
  assert.equal(visibilityResult(before, { error: 'HTTP 404' }).status, 0);
  assert.notEqual(visibilityResult(after, { error: 'HTTP 404' }).status, 0);
  const propagated = visibilityResult(after, {
    visibility: 'public',
    first404: true,
  });
  assert.equal(propagated.status, 0, propagated.stderr);
  assert.equal(propagated.stdout, 'public');
  assert.match(publish, /linux\/amd64, %s/);
  assert.match(publish, /"\$ref" "\$visibility" "\$digest"/);
  assert.doesNotMatch(publish, /private Release assets|linux\/amd64, private/);
});

test('release dispatch stays offline; login/push and write permissions are publish-only', () => {
  const [buildJobs, publish] = release.split('\n  publish:\n');
  assert.ok(publish);
  assert.match(release, /push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:/);
  assert.doesNotMatch(buildJobs, /docker\/login-action|docker push|push: true/);
  assert.doesNotMatch(buildJobs, /contents: write|packages: write/);
  assert.match(publish, /contents: write\n {6}packages: write/);
  assert.match(
    publish,
    /^ {4}if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/v'\)/,
  );
  for (const step of buildJobs.split(/\n {6}- /)) {
    if (!step.includes("if: github.event_name == 'workflow_dispatch'"))
      continue;
    assert.doesNotMatch(
      step,
      /docker\/login-action|docker push|gh release|secrets\./,
    );
  }
  assert.match(
    release,
    /Image tar files are Release assets.*public repository; verify their SHA-256 before importing/,
  );
});
