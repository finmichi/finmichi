// SPDX-License-Identifier: AGPL-3.0-only
import { waitForDaemon, daemonDiagnostics } from './daemon-ready.mjs';
// Opt-in only. Creates its own containers and synthetic secrets; never uses NAS config.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  chmodSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
if (!process.env.CI && process.env.FINMICHI_SYNTHETIC_CONTAINER_TEST !== '1')
  throw new Error('Synthetic opt-in required');
const root = mkdtempSync(
  join(process.env.D0_TEST_ROOT ?? '/tmp', 'finmichi-nas-'),
);
const gui = process.env.NAS_SMOKE_MODE === 'container-manager';
if (gui && !process.env.D0_DAEMON_CONTAINER)
  throw new Error('GUI smoke requires an isolated daemon');
const project = gui ? 'finmichi' : 'finmichi-nas-' + process.pid;
const imageTag = process.env.NAS_SMOKE_IMAGE_TAG ?? 'd0-test';
const image = (name) =>
  gui ? `ghcr.io/finmichi/${name}:${imageTag}` : `${name}:d0-test`;

const nodeImage = gui
  ? 'finmichi-proxy-fixture:node22'
  : 'node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392';
const run = (bin, args, options = {}) =>
  execFileSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
const docker = (args, options) => run('docker', args, options);
const env = {
  ...process.env,
  OIDC_HAIRPIN_HOST: 'sso.example.com',
  NAS_LAN_IP: '192.0.2.10', // Synthetic documentation address; no real SSO connection.
  IMAGE_TAG: imageTag,
  NAS_ROOT: root,
  PUBLIC_URL: 'https://proxy:8443',
  OIDC_ISSUER: 'https://mock:8080/default',
  OIDC_CLIENT_ID: 'synthetic',
  ALLOWED_SUBJECTS: 'synthetic-allowed',
  OIDC_SUBJECT_DISCOVERY: 'true',
  MARKET_DATA_ENABLED: 'false',
};
const override = join(root, 'override.json');
const envFile = join(root, '.env');
const guiConfig = {
  ...env,
  POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
  OIDC_CLIENT_SECRET: 'SyntheticMockClientOnly',
  ALLOWED_SUBJECTS: 'synthetic-allowed,synthetic-extra',
};
const writeGuiEnv = () =>
  writeFileSync(
    envFile,
    '\uFEFF' +
      readFileSync('deploy/container-manager/.env.example', 'utf8').split(
        '\n',
      )[0] +
      '\n' +
      Object.entries(guiConfig)
        .filter(([key]) =>
          [
            'NAS_LAN_IP',
            'OIDC_HAIRPIN_HOST',
            'IMAGE_TAG',
            'PUBLIC_URL',
            'OIDC_ISSUER',
            'OIDC_CLIENT_ID',
            'ALLOWED_SUBJECTS',
            'OIDC_SUBJECT_DISCOVERY',
            'MARKET_DATA_ENABLED',
            'POSTGRES_PASSWORD',
            'OIDC_CLIENT_SECRET',
          ].includes(key),
        )
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') +
      '\n',
    { mode: 0o600 },
  );
if (gui) {
  // These values must come only from the on-disk .env, not the parent process.
  for (const key of [
    'ALLOWED_SUBJECTS',
    'OIDC_SUBJECT_DISCOVERY',
    'POSTGRES_PASSWORD',
    'OIDC_CLIENT_SECRET',
  ])
    delete env[key];
  writeGuiEnv();
  const original = readFileSync(envFile, 'utf8');
  const noHostFile = join(root, 'missing-hairpin.env');
  writeFileSync(noHostFile, original.replace(/^OIDC_HAIRPIN_HOST=.*\n/m, ''), {
    mode: 0o600,
  });
  const noHost = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      noHostFile,
      '-f',
      'deploy/container-manager/compose.yaml',
      'config',
    ],
    {
      env: { ...env, OIDC_HAIRPIN_HOST: '' },
      encoding: 'utf8',
    },
  );
  assert.notEqual(noHost.status, 0);
  assert.match(noHost.stderr, /OIDC_HAIRPIN_HOST required/);
  rmSync(noHostFile);

  writeFileSync(
    envFile,
    original + '\nSYNTHETIC_DOLLAR=$UNSET_SYNTHETIC_VALUE_V012\n',
  );
  const warning = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      envFile,
      '-f',
      'deploy/container-manager/compose.yaml',
      'config',
      '--quiet',
    ],
    { env, encoding: 'utf8' },
  );
  assert.equal(warning.status, 0);
  assert.match(warning.stderr, /UNSET_SYNTHETIC_VALUE_V012.*not set/);
  writeFileSync(envFile, original);
}

const composeArgs = [
  'compose',
  ...(gui ? ['--env-file', envFile] : []),
  '-p',
  project,
  '-f',
  gui ? 'deploy/container-manager/compose.yaml' : 'deploy/compose.nas.yaml',
  '-f',
  override,
];
const compose = (args) => docker([...composeArgs, ...args], { env });
const id = (service) => compose(['ps', '-q', '--all', service]).trim();
const sql = (query) =>
  docker([
    'exec',
    id('postgres'),
    'psql',
    '-X',
    '-U',
    'finmichi',
    '-d',
    'finmichi',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    query,
  ]).trim();
async function healthy() {
  for (let n = 0; n < 90; n++) {
    if (
      ['app', 'worker', 'postgres'].every((s) => {
        const cid = id(s);
        return (
          cid &&
          JSON.parse(docker(['inspect', cid]))[0].State.Health?.Status ===
            'healthy'
        );
      })
    )
      return;
    await wait(2000);
  }
  throw new Error('Synthetic NAS services did not become healthy');
}
const proof = {};
let failed = false;
let cleanupFailure;
try {
  mkdirSync(join(root, 'secrets'), { mode: 0o700 });
  mkdirSync(join(root, 'postgres'));
  mkdirSync(join(root, 'backup'), { mode: 0o700 });
  const password = randomBytes(24).toString('hex');
  for (const [name, value] of Object.entries({
    'database-url': `postgres://finmichi:${password}@postgres:5432/finmichi`,
    'worker-database-url': `postgres://finmichi:${password}@postgres:5432/finmichi`,
    'postgres-password': password,
    'oidc-client-secret': '',
  })) {
    writeFileSync(join(root, 'secrets', name), value, { mode: 0o400 });
  }
  // Only generated fixtures are mounted; the parent path must also exist inside an isolated daemon.
  run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=synthetic-nas',
      '-addext',
      'subjectAltName=DNS:mock,DNS:proxy',
      '-keyout',
      join(root, 'tls-key'),
      '-out',
      join(root, 'tls-cert'),
    ],
    { stdio: 'ignore' },
  );
  run(
    'openssl',
    [
      'pkcs12',
      '-export',
      '-inkey',
      join(root, 'tls-key'),
      '-in',
      join(root, 'tls-cert'),
      '-out',
      join(root, 'mock.p12'),
      '-passout',
      'pass:',
    ],
    { stdio: 'ignore' },
  );
  for (const file of ['nas-test-proxy.mjs', 'nas-oidc-client.mjs'])
    copyFileSync('scripts/' + file, join(root, file));
  // Generated test TLS fixtures only; private parent directory still protects host access.
  for (const file of ['tls-key', 'tls-cert', 'mock.p12'])
    chmodSync(join(root, file), 0o444);
  if (!gui) {
    const pgUid = docker([
      'run',
      '--rm',
      '--entrypoint',
      'id',
      image('finmichi-postgres'),
      '-u',
      'postgres',
    ]).trim();
    docker([
      'run',
      '--rm',
      '--user',
      '0',
      '--entrypoint',
      'sh',
      '-v',
      root + ':/setup',
      image('finmichi-postgres'),
      '-c',
      'chown "$1:$1" /setup/postgres /setup/secrets/postgres-password; chmod 700 /setup/postgres; chown 65532:65532 /setup/secrets/database-url /setup/secrets/worker-database-url /setup/secrets/oidc-client-secret',
      'sh',
      pgUid,
    ]);
  }
  writeFileSync(
    override,
    JSON.stringify({
      services: {
        app: {
          image: image('finmichi'),
          environment: { NODE_EXTRA_CA_CERTS: '/test-ca' },
          volumes: [root + '/tls-cert:/test-ca:ro'],
          depends_on: {
            mock: { condition: 'service_started' },
            proxy: { condition: 'service_started' },
          },
        },
        worker: { image: image('finmichi-worker') },
        postgres: { image: image('finmichi-postgres') },
        mock: {
          image: 'finmichi-mock-oidc:6.0.7',
          ...(gui ? { pull_policy: 'never' } : {}),
          environment: {
            JSON_CONFIG: JSON.stringify({
              interactiveLogin: true,
              httpServer: {
                type: 'MockWebServerWrapper',
                ssl: {
                  keystoreFile: '/test/mock.p12',
                  keystorePassword: '',
                  keyPassword: '',
                },
              },
            }),
          },
          volumes: [root + '/mock.p12:/test/mock.p12:ro'],
          restart: 'unless-stopped',
        },
        proxy: {
          image: nodeImage,
          ...(gui ? { pull_policy: 'never' } : {}),
          command: ['node', '/test/nas-test-proxy.mjs'],
          volumes: [root + ':/test:ro'],
          environment: { NODE_EXTRA_CA_CERTS: '/test/tls-cert' },
          restart: 'unless-stopped',
        },
      },
    }),
  );
  compose(['config', '--quiet']);
  compose(['up', '-d', ...(gui ? ['--wait', '--wait-timeout', '180'] : [])]);
  await healthy();
  const psOutput = compose(['ps', '--format', 'json']).trim();
  // Compose 2.19 emits an array; newer versions emit one JSON object per line.
  proof.compose_ps = psOutput.startsWith('[')
    ? JSON.parse(psOutput)
    : psOutput.split('\n').map((row) => JSON.parse(row));
  for (const service of ['app', 'worker', 'postgres']) {
    const info = JSON.parse(docker(['inspect', id(service)]))[0];
    if (gui) {
      assert.deepEqual(
        Object.keys(info.NetworkSettings.Networks).sort(),
        service === 'postgres'
          ? ['finmichi_database']
          : ['finmichi_database', 'finmichi_default'],
      );
    }
    assert.equal(info.State.Health.Status, 'healthy');
    assert.equal(info.HostConfig.RestartPolicy.Name, 'unless-stopped');
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.ok(info.HostConfig.CapDrop.includes('ALL'));
    assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.equal(info.HostConfig.PidsLimit, gui ? null : 256);
    assert.equal(info.Config.StopTimeout, service === 'postgres' ? 60 : 30);
    assert.equal(info.HostConfig.Memory, 512 * 1024 * 1024);
    if (gui) assert.deepEqual(info.HostConfig.LogConfig.Config, {});
    else assert.equal(info.HostConfig.LogConfig.Config['max-size'], '10m');
    if (service === 'app')
      assert.deepEqual(info.HostConfig.PortBindings, {
        '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
      });
    if (service === 'postgres') {
      assert.deepEqual(info.HostConfig.PortBindings, {});
      assert.equal(Object.keys(info.NetworkSettings.Networks).length, 1);
    }
  }
  const client = (mode) =>
    JSON.parse(
      docker([
        'exec',
        id('proxy'),
        'node',
        '/test/nas-oidc-client.mjs',
        mode,
      ]).trim(),
    );
  proof.oidc_on = client('on');
  const discoveryLogs = compose(['logs', '--no-color', 'app']);
  assert.ok(discoveryLogs.includes('oidc_subject_discovery_enabled'));
  assert.ok(discoveryLogs.includes('oidc_subject_discovery_shown'));
  assert.ok(!discoveryLogs.includes('synthetic-discovery-'));
  if (gui) {
    const before = Object.fromEntries(
      ['app', 'worker', 'postgres'].map((name) => [name, id(name)]),
    );
    const mounts = JSON.parse(docker(['inspect', before.postgres]))[0].Mounts;
    const volume = mounts.find(
      (m) => m.Destination === '/var/lib/postgresql/data',
    );
    assert.equal(volume.Type, 'volume');
    assert.equal(volume.Name, 'finmichi-db');
    const data = sql('SELECT id FROM users ORDER BY id;');
    assert.ok(data);
    guiConfig.ALLOWED_SUBJECTS = 'synthetic-allowed';
    guiConfig.OIDC_SUBJECT_DISCOVERY = 'false';
    writeGuiEnv();
    compose(['up', '-d', ...(gui ? ['--wait', '--wait-timeout', '180'] : [])]);
    await healthy();
    assert.notEqual(id('app'), before.app);
    assert.equal(id('worker'), before.worker);
    assert.equal(id('postgres'), before.postgres);
    assert.equal(sql('SELECT id FROM users ORDER BY id;'), data);
    const appEnv = JSON.parse(docker(['inspect', id('app')]))[0].Config.Env;
    assert.ok(appEnv.includes('ALLOWED_SUBJECTS=synthetic-allowed'));
    assert.ok(appEnv.includes('OIDC_SUBJECT_DISCOVERY=false'));
    proof.dotenv_recreate = {
      only_app: true,
      postgres_and_worker_unchanged: true,
      data_preserved: true,
      volume: volume.Name,
      gui_tested: false,
    };
  } else {
    env.OIDC_SUBJECT_DISCOVERY = 'false';
    compose(['up', '-d', '--no-deps', '--force-recreate', 'app']);
  }
  await healthy();
  proof.oidc_off = client('off');
  assert.equal(
    sql(
      "SELECT count(*) FROM users WHERE oidc_subject LIKE 'synthetic-discovery%';",
    ),
    '0',
  );
  assert.equal(sql('SELECT count(*) FROM sessions;'), '0');
  assert.equal(
    sql(
      "SELECT count(*) FROM audit_logs WHERE row_to_json(audit_logs)::text LIKE '%synthetic-discovery%';",
    ),
    '0',
  );
  const logs = compose(['logs', '--no-color', 'app']);
  assert.ok(!logs.includes('synthetic-discovery-'));
  assert.ok(!logs.includes('192.0.2.123'));
  const proxyInfo = JSON.parse(docker(['inspect', id('proxy')]))[0];
  const proxyIp = Object.values(proxyInfo.NetworkSettings.Networks)[0]
    .IPAddress;
  assert.ok(
    logs.includes('"client_ip":"' + proxyIp + '"') ||
      logs.includes('"client_ip":"::ffff:' + proxyIp + '"'),
  );
  proof.proxy_source_verified = true;
  // A small, real, zero-sum synthetic ledger for dump/restore count verification.
  sql(
    "INSERT INTO ledgers(owner_id,name,base_currency) SELECT id,'Synthetic NAS backup','TWD' FROM users WHERE oidc_subject='synthetic-allowed' LIMIT 1;",
  );
  docker([
    'exec',
    id('app'),
    '/nodejs/bin/node',
    '--input-type=module',
    '-e',
    `
    import {readFile} from 'node:fs/promises';
    import {connect} from '@finmichi/db';
    import {itemService,transactionService} from '@finmichi/core';
    const db=connect(process.env.DATABASE_URL ?? (await readFile('/run/secrets/database-url','utf8')).trim());
    try {
      const [l]=await db\`SELECT id,owner_id FROM ledgers WHERE name='Synthetic NAS backup'\`;
      const items=itemService(db),cash=await items.create(l.owner_id,l.id,{name:'Synthetic cash',kind:'asset',currency:'TWD'}),expense=await items.create(l.owner_id,l.id,{name:'Synthetic expense',kind:'expense',currency:'TWD'});
      await transactionService(db).create(l.owner_id,l.id,{occurred_on:'2026-10-24',memo:'Synthetic NAS backup test',entries:[{item_id:cash.id,amount:'-1.00'},{item_id:expense.id,amount:'1.00'}]});
    } finally {await db.end();}
  `,
  ]);
  const counts = sql(
    'SELECT count(*) FROM ledgers; SELECT count(*) FROM transactions;',
  ).split('\n');
  const version = sql('SELECT max(name) FROM schema_migrations;');
  assert.match(version, /^0028_/);
  const backupEnv = {
    ...process.env,
    BACKUP_DIR: join(root, 'backup'),
    ...(gui ? {} : { POSTGRES_CONTAINER: id('postgres') }),
  };
  writeFileSync(join(root, 'backup', 'unrelated.dump'), 'synthetic sentinel');
  const oldDump = join(root, 'backup', 'life-ledger-20000101-000000.dump');
  writeFileSync(oldDump, 'legacy rotation sentinel');
  for (let i = 0; i < 32; i++)
    run('sh', ['deploy/nas-backup.sh'], { env: backupEnv });
  const files = readdirSync(join(root, 'backup')).filter((f) =>
    /^finmichi-\d{8}-\d{6}\.dump$/.test(f),
  );
  assert.equal(files.length, 30);
  assert.equal(statSync(join(root, 'backup')).mode & 0o777, 0o700);
  for (const f of files)
    assert.equal(statSync(join(root, 'backup', f)).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(join(root, 'backup', 'unrelated.dump'), 'utf8'),
    'synthetic sentinel',
  );
  assert.equal(readFileSync(oldDump, 'utf8'), 'legacy rotation sentinel');
  const dump = join(root, 'backup', files.sort().at(-1));
  writeFileSync(oldDump, readFileSync(dump));
  const oldDrill = run('sh', ['deploy/nas-restore-drill.sh', oldDump], {
    env: backupEnv,
  });
  assert.ok(oldDrill.includes('transactions=' + counts[1]));
  const drill = run('sh', ['deploy/nas-restore-drill.sh', dump], {
    env: backupEnv,
  });
  assert.ok(drill.includes('schema_version=' + version));
  assert.ok(drill.includes('ledgers=' + counts[0]));
  assert.ok(drill.includes('transactions=' + counts[1]));
  assert.equal(
    sql("SELECT count(*) FROM pg_database WHERE datname='finmichi_drill';"),
    '0',
  );
  docker([
    'exec',
    id('postgres'),
    'createdb',
    '-U',
    'finmichi',
    'finmichi_drill',
  ]);
  assert.throws(() =>
    run('sh', ['deploy/nas-restore-drill.sh', dump], {
      env: backupEnv,
      stdio: 'pipe',
    }),
  );
  assert.equal(
    sql("SELECT count(*) FROM pg_database WHERE datname='finmichi_drill';"),
    '1',
  );
  docker([
    'exec',
    id('postgres'),
    'dropdb',
    '-U',
    'finmichi',
    'finmichi_drill',
  ]);
  const incomplete = join(root, 'incomplete.dump');
  writeFileSync(
    incomplete,
    execFileSync('docker', [
      'exec',
      id('postgres'),
      'pg_dump',
      '-U',
      'finmichi',
      '-d',
      'postgres',
      '-Fc',
    ]),
  );
  assert.throws(() =>
    run('sh', ['deploy/nas-restore-drill.sh', incomplete], {
      env: backupEnv,
      stdio: 'pipe',
    }),
  );
  assert.equal(
    sql("SELECT count(*) FROM pg_database WHERE datname='finmichi_drill';"),
    '0',
  );
  assert.equal(sql('SELECT count(*) FROM transactions;'), counts[1]);
  compose(['stop', 'postgres']);
  assert.throws(() =>
    run('sh', ['deploy/nas-backup.sh'], { env: backupEnv, stdio: 'pipe' }),
  );
  assert.ok(
    !readdirSync(join(root, 'backup')).some(
      (f) => f.endsWith('.tmp') || f.endsWith('.lock'),
    ),
  );
  assert.equal(
    readdirSync(join(root, 'backup')).filter((f) => /^finmichi-/.test(f))
      .length,
    30,
  );
  compose(['start', 'postgres']);
  await healthy();
  proof.backup = {
    attempts: 32,
    legacy_name_restore: true,
    legacy_excluded_from_rotation: true,
    retained: 30,
    mode: '600',
    directory_mode: '700',
    stopped_pg_exit_nonzero: true,
    no_tmp: true,
    drill: drill.trim(),
    drill_removed: true,
    preexisting_drill_preserved: true,
    failed_drill_removed: true,
    source_unchanged: true,
  };
  if (gui) {
    const oldPassword = guiConfig.POSTGRES_PASSWORD;
    const beforeData = sql('SELECT count(*) FROM transactions;');
    guiConfig.POSTGRES_PASSWORD = randomBytes(24).toString('hex');
    writeGuiEnv();
    compose(['up', '-d', '--no-deps', '--force-recreate', 'app', 'worker']);
    let classified = false;
    for (let i = 0; i < 40; i++) {
      const appLogs = compose(['logs', '--no-color', 'app']);
      const workerLogs = compose(['logs', '--no-color', 'worker']);
      for (const log of [appLogs, workerLogs]) {
        assert.ok(
          !log.includes(oldPassword) &&
            !log.includes(guiConfig.POSTGRES_PASSWORD),
        );
        assert.ok(!log.includes('postgres://'));
      }
      if (
        appLogs.includes('"code":"db_auth_failed"') &&
        workerLogs.includes('"code":"db_auth_failed"')
      ) {
        classified = true;
        break;
      }
      await wait(1000);
    }
    assert.ok(
      classified,
      'both app and worker must classify initialized-volume password mismatch',
    );
    guiConfig.POSTGRES_PASSWORD = oldPassword;
    writeGuiEnv();
    compose(['up', '-d', '--no-deps', '--force-recreate', 'app', 'worker']);
    await healthy();
    assert.equal(sql('SELECT count(*) FROM transactions;'), beforeData);
    proof.negative_env = {
      bom_comment_started: true,
      dollar_warning: true,
      initialized_volume_password_mismatch: 'db_auth_failed (app and worker)',
      secrets_absent: true,
      recovered_data_preserved: true,
    };
  }
  if (process.env.D0_DAEMON_CONTAINER) {
    const outer = { ...process.env };
    delete outer.DOCKER_HOST;
    const daemon = process.env.D0_DAEMON_CONTAINER;
    const d = JSON.parse(docker(['inspect', daemon], { env: outer }))[0];
    assert.equal(d.Config.Labels['finmichi.synthetic'], 'd0');
    assert.ok(!d.Mounts.some((m) => m.Source === '/var/run/docker.sock'));
    // The outer daemon must have time to stop inner services (postgres: 60s).
    docker(['restart', '--time', '90', daemon], { env: outer });
    try {
      proof.daemon_ready_ms = await waitForDaemon(daemon, outer, process.env);
    } catch (error) {
      daemonDiagnostics(daemon, outer);
      throw error;
    }
    await healthy();
    proof.isolated_daemon_restart = 'all three healthy';
  } else {
    proof.isolated_daemon_restart = 'not requested (shared daemon untouched)';
  }
  proof.schema_version = version;
  proof.mode = gui ? 'container-manager-compose-equivalent' : 'nas';
  console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  failed = true;
  throw error;
} finally {
  try {
    if (existsSync(override)) compose(['down', '-v', '--remove-orphans']);
  } catch (error) {
    cleanupFailure ??= error;
    console.error(
      'Secondary synthetic cleanup failure; preserving original failure',
    );
  } finally {
    try {
      // Only this script's mkdtemp directory; no existing data path is accepted.
      docker([
        'run',
        '--rm',
        '--user',
        '0',
        '--entrypoint',
        'sh',
        '-v',
        root + ':/cleanup',
        image('finmichi-postgres'),
        '-c',
        'rm -rf /cleanup/postgres /cleanup/secrets',
      ]);
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupFailure ??= error;
      console.error(
        'Secondary fixture cleanup failure; outer daemon cleanup will remove its volumes',
      );
    }
  }
}

if (!failed && cleanupFailure) throw cleanupFailure;
