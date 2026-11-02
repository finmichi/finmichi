// SPDX-License-Identifier: AGPL-3.0-only
// Runs only inside container-manager-smoke's network-none Docker 24 daemon.
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { backupInitializationSmoke } from './backup-initialization-smoke.mjs';

export async function backupErrorsSmoke({ inner, env, root }) {
  const pg = 'backup-errors-postgres';
  const idle = 'backup-errors-not-ready';
  const runner = 'backup-errors-runner';
  const pgImage = 'ghcr.io/finmichi/finmichi-postgres:d1b-test';
  const script = join(root, 'backup-under-test.sh');
  copyFileSync('deploy/nas-backup.sh', script);
  const results = [];
  const exec = (name, args) => inner(['exec', name, ...args]);
  const sql = (query) =>
    exec(pg, [
      'psql',
      '-U',
      'finmichi',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    ]);
  try {
    inner([
      'run',
      '--pull=never',
      '-d',
      '--name',
      pg,
      '--network',
      'none',
      '--tmpfs',
      '/var/lib/postgresql/data:mode=1777',
      '-e',
      'PGDATA=/var/lib/postgresql/data/pgdata',
      '-e',
      'POSTGRES_USER=finmichi',
      '-e',
      'POSTGRES_DB=finmichi',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      pgImage,
    ]);
    inner([
      'run',
      '--pull=never',
      '-d',
      '--name',
      idle,
      '--network',
      'none',
      '--entrypoint',
      'sleep',
      pgImage,
      'infinity',
    ]);
    inner([
      'run',
      '--pull=never',
      '-d',
      '--name',
      runner,
      '--network',
      'none',
      '--tmpfs',
      '/backup:size=8m',
      '--tmpfs',
      '/small:size=128k',
      '-v',
      `${root}:${root}:Z`,
      '-e',
      `DOCKER_HOST=${env.DOCKER_HOST}`,
      '-e',
      `PATH=${join(root, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
      'finmichi-proxy-fixture:node22',
      'sleep',
      'infinity',
    ]);
    const initialization = await backupInitializationSmoke({
      inner,
      env,
      root,
      runner,
      script,
      pgImage,
    });
    for (let i = 0; ; i++) {
      const ready = spawnSync(
        'docker',
        ['exec', pg, 'pg_isready', '-h', '127.0.0.1', '-q', '-U', 'finmichi'],
        { env },
      );
      if (ready.status === 0) break;
      assert.ok(i < 60, 'synthetic postgres did not initialize');
      await wait(500);
    }
    // Incompressible synthetic data makes the 128 KiB tmpfs fail during pg_dump.
    exec(pg, [
      'psql',
      '-U',
      'finmichi',
      '-d',
      'finmichi',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'CREATE TABLE synthetic_payload AS SELECT i,md5(i::text) AS value FROM generate_series(1,30000) i;',
    ]);
    exec(runner, [
      'sh',
      '-c',
      'printf sentinel > /backup/unrelated.dump; printf sentinel > /backup/finmichi-20000101-000000.dump',
    ]);
    function attempt(code, options = {}) {
      const started = Date.now();
      const args = [
        'exec',
        '-e',
        `POSTGRES_CONTAINER=${options.container ?? pg}`,
        '-e',
        `BACKUP_DIR=${options.dir ?? '/backup'}`,
        '-e',
        `BACKUP_WAIT_SECONDS=${options.wait ?? 0}`,
        '-e',
        `KEEP=${options.keep ?? 30}`,
        runner,
        'sh',
        script,
      ];
      const result = spawnSync('docker', args, {
        env,
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(result.signal, null, `${code}: must finish without timeout`);
      assert.equal(result.error, undefined);
      assert.equal(result.status, code === 'success' ? 0 : 1);
      if (code !== 'success') {
        assert.equal(result.stderr, `backup_error=${code}\n`);
        assert.equal(result.stdout, '');
      } else
        assert.match(
          result.stdout,
          /^file=finmichi-.* bytes=\d+ retained=\d+\n$/,
        );
      const leftovers = exec(runner, [
        'sh',
        '-c',
        "find /backup /small /tmp -name '*.tmp' -o -name '*.lock' -o -name 'finmichi-backup-error.*' -o -name '.finmichi-write.*'",
      ]).trim();
      assert.equal(
        leftovers,
        options.locked ? '/backup/.finmichi-backup.lock' : '',
      );
      assert.equal(exec(runner, ['cat', '/backup/unrelated.dump']), 'sentinel');
      assert.equal(
        exec(runner, ['cat', '/backup/finmichi-20000101-000000.dump']),
        'sentinel',
      );
      const elapsed = Date.now() - started;
      results.push({
        code,
        exit: result.status,
        elapsed_ms: elapsed,
        sanitized: true,
        no_temporary_files: true,
      });
      return elapsed;
    }
    for (const keep of ['0', '-1', 'x', '999999999999999999999'])
      attempt('config_invalid', { keep });
    for (const wait of ['-1', 'x', '999999999999999999999'])
      attempt('config_invalid', { wait });
    exec(runner, ['mkdir', '/backup/.finmichi-backup.lock']);
    exec(runner, [
      'sh',
      '-c',
      'printf owner > /backup/.finmichi-backup.lock/owner',
    ]);
    attempt('backup_locked', { locked: true });
    assert.equal(
      exec(runner, ['cat', '/backup/.finmichi-backup.lock/owner']),
      'owner',
    );
    exec(runner, ['rm', '/backup/.finmichi-backup.lock/owner']);
    exec(runner, ['rmdir', '/backup/.finmichi-backup.lock']);
    attempt('container_not_running', {
      container: 'synthetic-container-absent',
    });
    inner(['stop', idle]);
    attempt('container_not_running', { container: idle });
    inner(['start', idle]);
    const elapsed = attempt('db_not_ready', { container: idle, wait: 2 });
    assert.ok(
      elapsed >= 2000 && elapsed < 10000,
      `configured readiness bound: ${elapsed}ms`,
    );
    attempt('dir_not_writable', { dir: '/proc/finmichi-synthetic-backup' });
    attempt('disk_full', { dir: '/small' });
    const hba = 'local all all scram-sha-256\n';
    exec(pg, [
      'sh',
      '-c',
      'printf "%s" "$1" > "$PGDATA/pg_hba.conf"; pg_ctl reload -D "$PGDATA"',
      'sh',
      hba,
    ]);
    await wait(500);
    attempt('db_auth_failed');
    exec(pg, [
      'sh',
      '-c',
      'printf "local all all trust\\n" > "$PGDATA/pg_hba.conf"; pg_ctl reload -D "$PGDATA"',
    ]);
    await wait(500);
    attempt('success');
    sql('DROP DATABASE finmichi;');
    attempt('dump_failed');
    return {
      result: 'PASS',
      initialization,
      cases: results,
      real_pg_dump: true,
      failure_fixtures: 'isolated Docker 24, network none; no command stubs',
    };
  } finally {
    for (const name of [runner, idle, pg])
      inner(['rm', '-fv', name], { stdio: 'ignore' });
  }
}
