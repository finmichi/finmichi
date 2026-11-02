// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = mkdtempSync(join(tmpdir(), 'deploy-bundle-'));
const files = [
  'compose.nas.yaml',
  '.env.nas.example',
  'nas-backup.sh',
  'nas-restore-drill.sh',
  'RUNBOOK-nas.md',
  'container-manager/compose.yaml',
  'container-manager/.env.example',
  'container-manager/README.md',
];
const destinations = files.map((file) =>
  file.startsWith('container-manager/')
    ? file
        .replace('container-manager/', '')
        .replace('compose.yaml', 'docker-compose.yaml')
    : file.endsWith('.sh')
      ? file
      : 'ssh/' + file,
);
const run = (bin, args, options = {}) =>
  execFileSync(bin, args, { encoding: 'utf8', ...options });
try {
  // Synthetic source tree includes a forbidden sentinel: the allowlist excludes it.
  const repo = join(root, 'synthetic repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'deploy/container-manager'), { recursive: true });
  const builder = join(repo, 'scripts/build-deploy-bundle.sh');
  copyFileSync('scripts/build-deploy-bundle.sh', builder);
  for (const file of files)
    copyFileSync(join('deploy', file), join(repo, 'deploy', file));
  writeFileSync(join(repo, 'deploy/.env.nas'), 'SYNTHETIC_NOT_FOR_BUNDLE=1\n');
  const build = (version, out) => run('sh', [builder, version, out]);
  const out = join(root, 'first');
  build('v0.1.0-test', out);
  const name = 'finmichi-deploy-v0.1.0-test.tar.gz';
  const zipName = name.replace('.tar.gz', '.zip');
  const fileHashes = name.replace('.tar.gz', '.files.sha256');
  assert.deepEqual(
    readdirSync(out).sort(),
    [name, name + '.sha256', zipName, zipName + '.sha256', fileHashes].sort(),
  );
  const archive = join(out, name);
  assert.deepEqual(run('tar', ['-tzf', archive]).trim().split('\n'), [
    ...destinations,
    'SHA256SUMS',
  ]);
  run('sha256sum', ['-c', name + '.sha256'], { cwd: out });
  const extracted = join(root, 'NAS_ROOT/deploy');
  mkdirSync(extracted, { recursive: true });
  run('tar', ['-xzf', archive, '-C', extracted]);
  for (const [index, file] of files.entries()) {
    const destination = destinations[index];
    assert.deepEqual(
      readFileSync(join(extracted, destination)),
      readFileSync(join('deploy', file)),
    );
    assert.equal(
      statSync(join(extracted, destination)).mode & 0o777,
      file.endsWith('.sh') ? 0o755 : 0o644,
    );
  }
  const unzipped = join(root, 'unzipped');
  mkdirSync(unzipped);
  run('python3', ['-m', 'zipfile', '-e', join(out, zipName), unzipped]);
  for (const file of [...destinations, 'SHA256SUMS']) {
    assert.deepEqual(
      readFileSync(join(unzipped, file)),
      readFileSync(join(extracted, file)),
    );
  }
  run('sha256sum', ['-c', 'SHA256SUMS'], { cwd: extracted });
  run('sha256sum', ['-c', join(out, fileHashes)], { cwd: extracted });
  assert.equal(
    readFileSync(join(out, fileHashes), 'utf8').trim().split('\n').length,
    files.length + 1,
  );
  run('sha256sum', ['-c', zipName + '.sha256'], { cwd: out });
  // Copy metadata and source mtime do not affect the bundle checksum.
  for (const file of files) {
    utimesSync(join(repo, 'deploy', file), 1234567890, 1234567890);
    chmodSync(join(repo, 'deploy', file), 0o600);
  }
  const second = join(root, 'second');
  build('v0.1.0-test', second);
  assert.deepEqual(readFileSync(archive), readFileSync(join(second, name)));
  assert.deepEqual(
    readFileSync(join(out, zipName)),
    readFileSync(join(second, zipName)),
  );
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(archive, 'synthetic tamper');
  assert.notEqual(
    spawnSync('sha256sum', ['-c', name + '.sha256'], { cwd: out }).status,
    0,
  );
  assert.throws(() => build('../invalid', join(root, 'invalid')), {
    status: 1,
  });
  rmSync(join(repo, 'deploy/compose.nas.yaml'));
  symlinkSync('.env.nas', join(repo, 'deploy/compose.nas.yaml'));
  assert.throws(() => build('unsafe', join(root, 'unsafe')), { status: 1 });
  assert.deepEqual(readdirSync(join(root, 'unsafe')), []);
  rmSync(join(repo, 'deploy/compose.nas.yaml'));
  assert.throws(() => build('missing', join(root, 'missing')), { status: 1 });
  // A DSM-like empty PATH must fail before creating directories or a lock.
  const backupDir = join(root, 'must-not-exist');
  const missingDocker = spawnSync(
    '/bin/sh',
    [resolve('deploy/nas-backup.sh')],
    {
      env: { PATH: join(root, 'no-tools'), BACKUP_DIR: backupDir },
      encoding: 'utf8',
    },
  );
  assert.equal(missingDocker.status, 1);
  assert.match(missingDocker.stderr, /docker not found in PATH/);
  assert.equal(existsSync(backupDir), false);
  console.log(
    JSON.stringify({
      result: 'PASS',
      files: 8,
      zip_tar_content_equal: true,
      per_file_checksums_verified: true,
      reproducible: true,
      checksum_tamper_rejected: true,
      unsafe_source_rejected: true,
      missing_docker_no_side_effects: true,
      synthetic_bundle_sha256: hash,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
