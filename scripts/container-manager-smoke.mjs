// SPDX-License-Identifier: AGPL-3.0-only
// Opt-in synthetic offline daemon only. All host images must already exist.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { waitForDaemon, daemonDiagnostics } from './daemon-ready.mjs';
import { createHash } from 'node:crypto';
import { backupErrorsSmoke } from './backup-errors-smoke.mjs';
if (!process.env.CI && process.env.FINMICHI_SYNTHETIC_CONTAINER_TEST !== '1')
  throw new Error('Synthetic opt-in required');
if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT)
  throw new Error(
    'Unset DOCKER_HOST/DOCKER_CONTEXT; this script creates its own daemon',
  );
const run = (bin, args, options = {}) =>
  execFileSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
const docker = (args, options = {}) => run('docker', args, options);
const daemonImage =
  'docker:24.0.2-dind@sha256:1d148deae16a6bb4c89224c636e1fd1799a4d5925f545861ce0d7bea3a527b5d';
const nodeImage =
  'node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392';
const packages = ['finmichi', 'finmichi-worker', 'finmichi-postgres'];
for (const ref of [
  daemonImage,
  nodeImage,
  'finmichi-mock-oidc:6.0.7',
  ...packages.map((p) => `${p}:d0-test`),
])
  docker(['image', 'inspect', ref], { stdio: 'ignore' });
// /tmp is shadowed by the DinD entrypoint; /var/tmp also stays outside repo scans.
const parent = resolve('/var/tmp');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'container-manager-'));
const socket = join(root, 'socket');
mkdirSync(socket, { mode: 0o700 });
const daemon = 'finmichi-gui-smoke-' + process.pid;
const hostDocker = run('sh', ['-c', 'command -v docker']).trim();
const cliBin = join(root, 'bin');
const cliConfig = join(root, 'docker-config');
mkdirSync(cliBin);
mkdirSync(join(cliConfig, 'cli-plugins'), { recursive: true });
const env = {
  ...process.env,
  PATH: cliBin + ':' + process.env.PATH,
  DOCKER_CONFIG: cliConfig,
  DOCKER_HOST: 'unix://' + join(socket, 'docker.sock'),
};
const inner = (args, options = {}) => docker(args, { env, ...options });
const hostCpus = Number(docker(['info', '--format', '{{.NCPU}}']).trim());
assert.ok(Number.isInteger(hostCpus) && hostCpus > 0);
const daemonCpus = Math.min(4, hostCpus);
const proof = { daemon_cpu_limit: daemonCpus };
let created = false;
const hostBefore = docker(['ps', '--format', '{{.ID}} {{.Names}}'])
  .trim()
  .split('\n')
  .sort();
try {
  const assets = join(root, 'assets');
  mkdirSync(assets);
  for (const name of packages) {
    docker(['tag', `${name}:d0-test`, `ghcr.io/finmichi/${name}:d1b-test`]);
    run('sh', ['scripts/export-image-asset.sh', name, 'd1b-test', assets]);
  }
  docker(['tag', nodeImage, 'finmichi-proxy-fixture:node22']);
  docker([
    'save',
    'finmichi-proxy-fixture:node22',
    'finmichi-mock-oidc:6.0.7',
    '-o',
    join(root, 'fixtures.tar'),
  ]);
  // No host Docker socket, no external network, no registry credentials.
  docker([
    'run',
    '--pull=never',
    '-d',
    '--name',
    daemon,
    '--label',
    'finmichi.synthetic=d0',
    '--privileged',
    '--network',
    'none',
    '--cpus',
    String(daemonCpus),
    '--memory',
    '4g',
    '-e',
    'DOCKER_TLS_CERTDIR=',
    '-v',
    socket + ':/var/run:Z',
    '-v',
    root + ':' + root + ':Z',
    daemonImage,
    '--host=unix:///var/run/docker.sock',
    '--group=' + process.getgid(),
  ]);
  created = true;
  // Use the pinned daemon's own CLI/Compose, not the host's newer plugin.
  docker(['cp', daemon + ':/usr/local/bin/docker', join(cliBin, 'docker24')]);
  docker([
    'cp',
    daemon + ':/usr/local/libexec/docker/cli-plugins/docker-compose',
    join(cliConfig, 'cli-plugins/docker-compose'),
  ]);
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    join(cliBin, 'docker'),
    '#!/bin/sh\nif [ -n "${DOCKER_HOST:-}" ]; then exec ' +
      quote(join(cliBin, 'docker24')) +
      ' "$@"; else exec ' +
      quote(hostDocker) +
      ' "$@"; fi\n',
    { mode: 0o755 },
  );
  await waitForDaemon(daemon, process.env, env);
  const checkSocket = () => {
    const socketStat = statSync(join(socket, 'docker.sock'));
    assert.equal(socketStat.gid, process.getgid());
    assert.equal(socketStat.mode & 0o777, 0o660);
  };
  checkSocket();
  const info = JSON.parse(docker(['inspect', daemon]))[0];
  assert.equal(info.HostConfig.NetworkMode, 'none');
  assert.ok(!info.Mounts.some((m) => m.Source === '/var/run/docker.sock'));
  const version = JSON.parse(inner(['version', '--format', '{{json .}}']));
  assert.equal(version.Server.Version, '24.0.2');
  assert.equal(version.Client.Version, '24.0.2');
  const composeVersion = inner(['compose', 'version', '--short']).trim();
  assert.equal(composeVersion.replace(/^v/, ''), '2.19.1');
  proof.versions = {
    engine: version.Server.Version,
    client: version.Client.Version,
    compose: composeVersion,
    nas_gui: 'not tested (D3)',
  };
  const started = new Date().toISOString();
  proof.images = [];
  for (const name of packages) {
    const path = join(assets, `finmichi-image-${name}-d1b-test.tar`);
    const metadata = JSON.parse(readFileSync(path + '.json', 'utf8'));
    assert.equal(
      createHash('sha256').update(readFileSync(path)).digest('hex'),
      metadata.sha256,
    );
    inner(['load', '-i', path]);
    const loaded = JSON.parse(inner(['image', 'inspect', metadata.ref]))[0];
    assert.deepEqual(loaded.RootFS.Layers, metadata.diff_ids);
    // Classic store returns config ID; containerd returns manifest ID, so re-export
    // with the same helper and independently read the actual loaded config bytes.
    run(
      'sh',
      [
        'scripts/export-image-asset.sh',
        name,
        'd1b-test',
        join(root, 'reexport'),
      ],
      { env },
    );
    const again = JSON.parse(
      readFileSync(join(root, 'reexport', metadata.file + '.json'), 'utf8'),
    );
    assert.equal(again.image_id, metadata.image_id);
    proof.images.push({
      ref: metadata.ref,
      tar_sha256: metadata.sha256,
      image_id: metadata.image_id,
      loaded_same_config: true,
    });
  }
  inner(['load', '-i', join(root, 'fixtures.tar')]);
  proof.backup_errors = await backupErrorsSmoke({ inner, env, root });
  const result = run(process.execPath, ['scripts/nas-smoke.mjs'], {
    env: {
      ...env,
      D0_TEST_ROOT: root,
      D0_DAEMON_CONTAINER: daemon,
      NAS_SMOKE_MODE: 'container-manager',
      NAS_SMOKE_IMAGE_TAG: 'd1b-test',
      FINMICHI_SYNTHETIC_CONTAINER_TEST: '1',
    },
  });
  proof.staging = JSON.parse(result);
  checkSocket();
  proof.socket_group_owned_by_runner = true;
  const missing = join(root, 'missing.yaml');
  writeFileSync(
    missing,
    'services:\n  absent:\n    image: ghcr.io/finmichi/finmichi:not-imported-synthetic\n    pull_policy: never\n',
  );
  const negative = spawnSync(
    'docker',
    ['compose', '-p', 'missing-image-proof', '-f', missing, 'up', '-d'],
    { env, encoding: 'utf8' },
  );
  assert.notEqual(negative.status, 0);
  assert.match(negative.stderr, /No such image|not found|does not exist/i);
  inner(['compose', '-p', 'missing-image-proof', '-f', missing, 'down']);
  const events = inner([
    'events',
    '--since',
    started,
    '--until',
    new Date().toISOString(),
    '--filter',
    'type=image',
    '--format',
    '{{json .}}',
  ]).trim();
  const rows = events ? events.split('\n').map((l) => JSON.parse(l)) : [];
  assert.equal(
    rows.filter((r) => r.Action === 'pull' || r.status === 'pull').length,
    0,
  );
  assert.equal(inner(['ps', '-aq']).trim(), '');
  assert.equal(inner(['volume', 'ls', '-q']).trim(), '');
  proof.offline = {
    daemon_network: 'none',
    registry_credentials_mounted: false,
    registry_pull_events: 0,
    missing_image_rejected: true,
  };
  proof.result = 'PASS';
} catch (error) {
  if (created) daemonDiagnostics(daemon, process.env);
  throw error;
} finally {
  if (created) docker(['rm', '-fv', daemon], { stdio: 'ignore' });
  // DinD creates root-owned socket directories. Remove only this mkdtemp
  // directory's socket tree using a preloaded local helper, never a host path.
  docker(
    [
      'run',
      '--pull=never',
      '--rm',
      '--network',
      'none',
      '--user',
      '0',
      '--entrypoint',
      'sh',
      '-v',
      root + ':/cleanup:Z',
      'finmichi-postgres:d0-test',
      '-c',
      'rm -rf /cleanup/socket',
    ],
    { stdio: 'ignore' },
  );
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(
    docker(['ps', '--format', '{{.ID}} {{.Names}}']).trim().split('\n').sort(),
    hostBefore,
  );
}
proof.cleanup = {
  isolated_daemon_removed: true,
  synthetic_data_removed: true,
  host_running_containers_unchanged: hostBefore.length,
};
console.log(JSON.stringify(proof, null, 2));
