// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { settings } from './app.js';
afterEach(() => vi.unstubAllEnvs());
function environment() {
  vi.stubEnv('PUBLIC_URL', 'https://synthetic.invalid');
  vi.stubEnv('OIDC_ISSUER', 'https://issuer.synthetic.invalid');
  vi.stubEnv('OIDC_CLIENT_ID', 'synthetic');
  vi.stubEnv('ALLOWED_SUBJECTS', 'synthetic-allowed');
  vi.stubEnv('DATABASE_URL', 'postgres://synthetic@localhost/synthetic');
  vi.stubEnv('MOCK_OIDC_INTERNAL_URL', '');
}
it('subject discovery defaults off and only explicit true in production enables it', () => {
  environment();
  for (const nodeEnv of ['test', 'development', 'production']) {
    vi.stubEnv('NODE_ENV', nodeEnv);
    for (const flag of ['', 'false', 'TRUE', '1', 'true']) {
      vi.stubEnv('OIDC_SUBJECT_DISCOVERY', flag);
      expect(settings().subjectDiscovery).toBe(
        nodeEnv === 'production' && flag === 'true',
      );
    }
  }
});
it('discovery never permits an empty subject allowlist or production mock transport', () => {
  environment();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('OIDC_SUBJECT_DISCOVERY', 'true');
  vi.stubEnv('ALLOWED_SUBJECTS', ', ');
  expect(() => settings()).toThrow('ALLOWED_SUBJECTS');
  vi.stubEnv('ALLOWED_SUBJECTS', 'synthetic');
  vi.stubEnv('MOCK_OIDC_INTERNAL_URL', 'http://localhost:8081');
  expect(() => settings()).toThrow('development-only');
});

it('factory reset defaults off and only literal true enables it', () => {
  environment();
  for (const value of ['', 'false', '1', 'TRUE', 'true']) {
    vi.stubEnv('FINMICHI_ALLOW_FACTORY_RESET', value);
    expect(settings().allowFactoryReset).toBe(value === 'true');
  }
});
