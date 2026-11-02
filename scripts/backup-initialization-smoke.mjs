// SPDX-License-Identifier: AGPL-3.0-only
// Real PostgreSQL initialization, held at the socket-only temporary server.
// Called exclusively inside the network-none Docker 24 smoke daemon.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';

export async function backupInitializationSmoke({
  inner,
  env,
  root,
  runner,
  script,
  pgImage,
}) {
  const results = [];
  for (const [variant, file] of [
    ['dev', 'deploy/compose.dev.yaml'],
    ['staging', 'deploy/compose.staging.yaml'],
    ['nas', 'deploy/compose.nas.yaml'],
    ['container-manager', 'deploy/container-manager/compose.yaml'],
  ]) {
    // Execute the exact healthcheck command from each production configuration.
    const command = readFileSync(file, 'utf8')
      .match(/pg_isready[^\n'\]]+/)?.[0]
      .trim();
    assert.equal(command, 'pg_isready -h 127.0.0.1 -U finmichi -d finmichi');
    const name = `backup-init-${variant}`;
    const volume = `${name}-data`;
    const init = join(root, `init-${variant}.sh`);
    writeFileSync(
      init,
      `#!/bin/sh
set -eu
printf ready > /tmp/init-held
while [ ! -f /tmp/release-init ]; do sleep 0.1; done
psql -U finmichi -d finmichi -v ON_ERROR_STOP=1 -c 'CREATE TABLE synthetic_after_init (id integer);'
`,
    );
    const probe = (args) =>
      spawnSync('docker', ['exec', name, ...args], { env, encoding: 'utf8' });
    const health = () =>
      inner(['inspect', '--format', '{{.State.Health.Status}}', name]).trim();
    const args = (seconds) => [
      'exec',
      '-e',
      `POSTGRES_CONTAINER=${name}`,
      '-e',
      'BACKUP_DIR=/initial-backup',
      '-e',
      `BACKUP_WAIT_SECONDS=${seconds}`,
      runner,
      'sh',
      script,
    ];
    let pending;
    try {
      assert.equal(
        inner(['volume', 'ls', '-q', '--filter', `name=^${volume}$`]).trim(),
        '',
      );
      inner(['volume', 'create', volume]);
      inner([
        'create',
        '--pull=never',
        '--name',
        name,
        '--network',
        'none',
        '-v',
        `${volume}:/var/lib/postgresql/data`,
        '-e',
        'PGDATA=/var/lib/postgresql/data/pgdata',
        '-e',
        'POSTGRES_USER=finmichi',
        '-e',
        'POSTGRES_DB=finmichi',
        '-e',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        '--health-cmd',
        command,
        '--health-interval',
        '1s',
        '--health-timeout',
        '2s',
        '--health-retries',
        '2',
        pgImage,
      ]);
      inner(['cp', init, `${name}:/docker-entrypoint-initdb.d/01-hold.sh`]);
      inner(['start', name]);
      for (let i = 0; ; i++) {
        if (probe(['test', '-f', '/tmp/init-held']).status === 0) break;
        assert.ok(
          i < 120,
          'temporary server did not reach initialization gate',
        );
        await wait(250);
      }
      assert.equal(probe(['pg_isready', '-q', '-U', 'finmichi']).status, 0);
      assert.notEqual(
        probe(['pg_isready', '-h', '127.0.0.1', '-q', '-U', 'finmichi']).status,
        0,
      );
      // Let Docker run multiple health probes while the temporary server is held.
      await wait(2500);
      assert.notEqual(health(), 'healthy');
      const tooEarly = spawnSync('docker', args(0), {
        env,
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(tooEarly.error, undefined);
      assert.equal(tooEarly.status, 1);
      assert.equal(tooEarly.stdout, '');
      assert.equal(tooEarly.stderr, 'backup_error=db_not_ready\n');
      assert.equal(
        inner(['exec', runner, 'sh', '-c', 'ls -A /initial-backup']).trim(),
        '',
      );

      // A second invocation starts before release and must wait for the final server.
      pending = spawn('docker', args(30), {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      pending.stdout.on('data', (data) => {
        stdout += data;
      });
      pending.stderr.on('data', (data) => {
        stderr += data;
      });
      const completion = new Promise((resolve, reject) => {
        pending.once('error', reject);
        pending.once('close', (status) => resolve(status));
      });
      const timeout = setTimeout(() => pending.kill('SIGKILL'), 45000);
      try {
        // Prove the backup acquired its lock before allowing init to finish.
        for (let i = 0; ; i++) {
          const locked = spawnSync(
            'docker',
            [
              'exec',
              runner,
              'test',
              '-d',
              '/initial-backup/.finmichi-backup.lock',
            ],
            { env },
          );
          if (locked.status === 0) break;
          assert.ok(
            i < 40 && pending.exitCode === null,
            'backup must wait during initialization',
          );
          await wait(100);
        }
        assert.equal(pending.exitCode, null);
        inner(['exec', name, 'touch', '/tmp/release-init']);
        assert.equal(await completion, 0, stderr);
      } finally {
        clearTimeout(timeout);
      }
      assert.equal(stderr, '');
      assert.match(stdout, /^file=finmichi-.* bytes=\d+ retained=1\n$/);
      for (let i = 0; health() !== 'healthy'; i++) {
        assert.ok(i < 60, 'final PostgreSQL must become healthy');
        await wait(250);
      }
      assert.equal(
        probe(['pg_isready', '-h', '127.0.0.1', '-q', '-U', 'finmichi']).status,
        0,
      );
      const dump = stdout.match(/^file=(\S+)/)[1];
      // The archive must include work performed after releasing the init gate.
      const listing = inner([
        'exec',
        runner,
        'sh',
        '-c',
        'docker exec -i "$1" pg_restore --list < "$2"',
        'sh',
        name,
        `/initial-backup/${dump}`,
      ]);
      assert.match(listing, /TABLE public synthetic_after_init/);
      inner(['exec', runner, 'rm', `/initial-backup/${dump}`]);
      inner(['exec', runner, 'rmdir', '/initial-backup']);
      results.push({
        variant,
        empty_named_volume: true,
        healthcheck: command,
        temporary_server: { socket: 'up', tcp: 'down', healthy: false },
        early_backup: 'db_not_ready',
        waiting_backup: 'success',
        final_health: 'healthy',
        final_init_table_in_archive: true,
      });
    } finally {
      if (pending && pending.exitCode === null) pending.kill('SIGKILL');
      inner(['rm', '-fv', name], { stdio: 'ignore' });
      inner(['volume', 'rm', volume], { stdio: 'ignore' });
    }
  }
  return results;
}
