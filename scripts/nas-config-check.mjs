// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const env = {
  ...process.env,
  OIDC_HAIRPIN_HOST: 'sso.example.com',
  NAS_LAN_IP: '192.0.2.10', // Synthetic documentation address; no real SSO connection.
  IMAGE_TAG: 'synthetic-contract',
  NAS_ROOT: '/tmp/synthetic-nas',
  PUBLIC_URL: 'https://synthetic.invalid',
  OIDC_ISSUER: 'https://issuer.synthetic.invalid',
  OIDC_CLIENT_ID: 'synthetic',
  ALLOWED_SUBJECTS: 'synthetic',
};
const args = [
  'compose',
  '-f',
  'deploy/compose.nas.yaml',
  'config',
  '--format',
  'json',
];
const c = JSON.parse(execFileSync('docker', args, { env, encoding: 'utf8' }));
assert.equal(c.name, 'finmichi');
assert.deepEqual(c.services.app.extra_hosts, ['sso.example.com=192.0.2.10']);
assert.ok(!c.services.worker.extra_hosts?.length);
for (const service of ['app', 'worker', 'postgres']) {
  const s = c.services[service];
  assert.ok(s.image.endsWith(':synthetic-contract'));
  assert.equal(s.restart, 'unless-stopped');
  assert.equal(s.stop_grace_period, service === 'postgres' ? '1m0s' : '30s');
  assert.equal(s.read_only, true);
  assert.deepEqual(s.cap_drop, ['ALL']);
  assert.ok(s.security_opt.includes('no-new-privileges:true'));
  assert.equal(s.environment.TZ, 'Asia/Taipei');
  for (const mount of s.volumes) assert.ok(!mount.bind?.selinux);
}
assert.equal(c.services.app.ports[0].host_ip, '127.0.0.1');
assert.equal(c.services.app.ports[0].published, '8080');
assert.equal(c.services.app.environment.TRUST_PROXY, '1');
assert.ok(!c.services.app.environment.TLS_KEY_FILE);
assert.ok(!c.services.postgres.ports?.length);
assert.deepEqual(Object.keys(c.services.postgres.networks), ['database']);
assert.equal(c.networks.database.internal, true);
assert.equal(c.services.worker.environment.MARKET_DATA_ENABLED, 'false');
for (const key of [
  'IMAGE_TAG',
  'NAS_ROOT',
  'NAS_LAN_IP',
  'OIDC_HAIRPIN_HOST',
  'PUBLIC_URL',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'ALLOWED_SUBJECTS',
]) {
  assert.throws(() =>
    execFileSync('docker', args, { env: { ...env, [key]: '' }, stdio: 'pipe' }),
  );
}
console.log('NAS Compose contract PASS; missing required values rejected');
