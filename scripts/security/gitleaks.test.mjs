// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
const scanner = resolve('scripts/security/gitleaks.mjs');
test('real pinned gitleaks rejects a synthetic secret in PR diff and accepts its removal; no value is logged', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'finmichi-secret-test-'));
  const git = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'Synthetic']);
    git(['config', 'user.email', 'synthetic@example.com']);
    writeFileSync(join(cwd, 'README.md'), 'synthetic\n');
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    const value = ['glpat', '9cN2aT7mP4xK8qV6rL3z'].join('-');
    writeFileSync(join(cwd, '.gitattributes'), '*.md -diff\n');
    writeFileSync(
      join(cwd, 'README.md'),
      'synthetic token = "' + value + '"\n',
    );
    git(['add', '.']);
    git(['commit', '-qm', 'synthetic negative probe']);
    const run = () =>
      spawnSync(process.execPath, [scanner], {
        cwd,
        env: {
          ...process.env,
          CI_BASE_SHA: base,
          CI_HEAD_SHA: git(['rev-parse', 'HEAD']),
        },
        encoding: 'utf8',
      });
    const bad = run();
    assert.equal(bad.status, 1, bad.stderr);
    assert.equal((bad.stdout + bad.stderr).includes(value), false);
    assert.match(bad.stdout, /gitlab-pat/);
    writeFileSync(join(cwd, 'README.md'), 'synthetic fixed\n');
    git(['add', '.']);
    git(['commit', '-qm', 'remove synthetic probe']);
    const good = run();
    assert.equal(good.status, 0, good.stderr);
    writeFileSync(join(cwd, 'outside-secret'), value);
    symlinkSync('outside-secret', join(cwd, 'tracked-link'));
    git(['add', 'tracked-link']);
    const linked = spawnSync(process.execPath, [scanner], {
      cwd,
      env: { ...process.env, CI_BASE_SHA: '', CI_HEAD_SHA: '' },
      encoding: 'utf8',
    });
    assert.equal(linked.status, 0, linked.stderr);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
