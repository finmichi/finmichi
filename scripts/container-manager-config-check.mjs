// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const env = {
  ...process.env,
  OIDC_HAIRPIN_HOST: 'sso.example.com',
  NAS_LAN_IP: '192.0.2.10',
  IMAGE_TAG: 'synthetic-contract',
  PUBLIC_URL: 'https://synthetic.invalid',
  OIDC_ISSUER: 'https://issuer.synthetic.invalid',
  OIDC_CLIENT_ID: 'synthetic',
  OIDC_CLIENT_SECRET: 'SyntheticOidcOnly',
  POSTGRES_PASSWORD: 'SyntheticDatabasePasswordOnly12345678',
  ALLOWED_SUBJECTS: 'synthetic',
};
const args = [
  'compose',
  '-f',
  'deploy/container-manager/compose.yaml',
  'config',
  '--format',
  'json',
];
const c = JSON.parse(execFileSync('docker', args, { env, encoding: 'utf8' }));
assert.equal(c.name, 'finmichi');
assert.deepEqual(c.services.app.extra_hosts, ['sso.example.com=192.0.2.10']);
assert.ok(!c.services.worker.extra_hosts?.length);
for (const name of ['app', 'worker', 'postgres']) {
  const s = c.services[name];
  assert.equal(s.pull_policy, 'never');
  assert.equal(s.restart, 'unless-stopped');
  assert.equal(s.read_only, true);
  assert.deepEqual(s.cap_drop, ['ALL']);
  assert.ok(s.security_opt.includes('no-new-privileges:true'));
  assert.equal(s.pids_limit, undefined);
  assert.equal(s.stop_grace_period, name === 'postgres' ? '1m0s' : '30s');
  assert.equal(Number(s.mem_limit), 512 * 1024 * 1024);
  assert.equal(s.logging, undefined);
  assert.ok(s.healthcheck.test.length);
  assert.ok(!Object.keys(s.environment).some((k) => k.endsWith('_FILE')));
  assert.ok((s.volumes ?? []).every((v) => v.type === 'volume'));
  assert.ok(!s.secrets);
  assert.equal(s.environment.TZ, 'Asia/Taipei');
}
assert.equal(c.services.app.ports[0].host_ip, '127.0.0.1');
assert.equal(c.services.app.ports[0].published, '8080');
assert.ok(!c.services.postgres.ports?.length);
assert.deepEqual(Object.keys(c.services.postgres.networks), ['database']);
assert.equal(c.networks.database.internal, true);
for (const name of ['app', 'worker']) {
  assert.equal(c.services[name].networks.default.priority, 100);
  assert.equal(c.services[name].networks.database.priority ?? 0, 0);
}
assert.deepEqual(
  c.services.postgres.volumes.map((v) => [v.source, v.target]),
  [['postgres-data', '/var/lib/postgresql/data']],
);
assert.equal(c.volumes['postgres-data'].name, 'finmichi-db');
assert.equal(
  c.services.app.environment.DATABASE_URL,
  c.services.worker.environment.DATABASE_URL,
);
assert.equal(
  c.services.postgres.environment.POSTGRES_PASSWORD,
  env.POSTGRES_PASSWORD,
);
const required = [
  'IMAGE_TAG',
  'NAS_LAN_IP',
  'OIDC_HAIRPIN_HOST',
  'PUBLIC_URL',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'POSTGRES_PASSWORD',
  'ALLOWED_SUBJECTS',
];
for (const key of required) {
  assert.throws(() =>
    execFileSync('docker', args, { env: { ...env, [key]: '' }, stdio: 'pipe' }),
  );
}
console.log(
  JSON.stringify({
    result: 'PASS',
    required: required.length,
    local_images_only: true,
    no_secret_mounts: true,
    named_volume: true,
  }),
);
