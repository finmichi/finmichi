// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connect, migrate } from '@finmichi/db';
import { sessionService, tokenHash } from './index.js';
if (!process.env.TEST_DATABASE_URL)
  throw new Error('TEST_DATABASE_URL required');
const db = connect(process.env.TEST_DATABASE_URL);
const sessions = sessionService(db, ['synthetic-allowed']);
beforeAll(async () => {
  await migrate(db);
});
afterAll(async () => {
  await db.end();
});
it('allowlist, hashed persistence, idle and absolute expiry, logout and audit work against PostgreSQL', async () => {
  expect(await sessions.login('https://synthetic.invalid', 'denied')).toBe(
    null,
  );
  const token = await sessions.login(
    'https://synthetic.invalid',
    'synthetic-allowed',
  );
  expect(token).toBeTruthy();
  const user = await sessions.authenticate(token!);
  expect(user?.subject).toBe('synthetic-allowed');
  const [row] =
    await db`SELECT token_hash FROM sessions WHERE token_hash=${tokenHash(token!)}`;
  expect(row?.token_hash).not.toBe(token);
  await db`UPDATE sessions SET last_seen_at=now()-interval '25 hours' WHERE token_hash=${tokenHash(token!)}`;
  expect(await sessions.authenticate(token!)).toBe(null);
  await db`UPDATE sessions SET created_at=now()-interval '8 days',last_seen_at=now(),expires_at=now()-interval '1 day' WHERE token_hash=${tokenHash(token!)}`;
  expect(await sessions.authenticate(token!)).toBe(null);
  await sessions.logout(token!);
  expect(await sessions.authenticate(token!)).toBe(null);
  const [audit] =
    await db`SELECT count(*)::int AS count FROM audit_logs WHERE user_id=${user!.id} AND action IN ('login','logout')`;
  expect(audit?.count).toBe(2);
});

it('denied login audits source IP and subject hash without creating a user or session', async () => {
  const subject = 'synthetic-denied-audit';
  const before = await db`SELECT count(*)::int AS count FROM sessions`;
  expect(
    await sessions.login(
      'https://audit.synthetic.invalid',
      subject,
      '192.0.2.10',
    ),
  ).toBeNull();
  const [audit] =
    await db`SELECT source_ip::text AS ip, subject_hash FROM audit_logs WHERE subject_hash=${tokenHash(subject)} ORDER BY id DESC LIMIT 1`;
  expect(audit?.ip).toBe('192.0.2.10/32');
  expect(audit?.subject_hash).toBe(tokenHash(subject));
  expect(JSON.stringify(audit)).not.toContain(subject);
  expect(
    await db`SELECT id FROM users WHERE oidc_subject=${subject}`,
  ).toHaveLength(0);
  expect(await db`SELECT count(*)::int AS count FROM sessions`).toEqual(before);
  expect(
    await sessions.login(
      'https://audit.synthetic.invalid',
      subject,
      'not-an-ip',
    ),
  ).toBeNull();
  const [invalid] =
    await db`SELECT source_ip FROM audit_logs WHERE subject_hash=${tokenHash(subject)} ORDER BY id DESC LIMIT 1`;
  expect(invalid?.source_ip).toBeNull();
});

it('successful login removes expired and idle sessions but preserves active sessions', async () => {
  const issuer = 'https://cleanup.synthetic.invalid';
  const expired = await sessions.login(issuer, 'synthetic-allowed');
  const idle = await sessions.login(issuer, 'synthetic-allowed');
  const active = await sessions.login(issuer, 'synthetic-allowed');
  await db`UPDATE sessions SET created_at=now()-interval '8 days', expires_at=now()-interval '1 day' WHERE token_hash=${tokenHash(expired!)}`;
  await db`UPDATE sessions SET last_seen_at=now()-interval '25 hours' WHERE token_hash=${tokenHash(idle!)}`;
  const fresh = await sessions.login(issuer, 'synthetic-allowed');
  const rows =
    await db`SELECT token_hash FROM sessions WHERE token_hash IN ${db([tokenHash(expired!), tokenHash(idle!), tokenHash(active!), tokenHash(fresh!)])}`;
  expect(rows.map((r) => r.token_hash).sort()).toEqual(
    [tokenHash(active!), tokenHash(fresh!)].sort(),
  );
  expect(await sessions.authenticate(active!)).not.toBeNull();
  expect(await sessions.authenticate(fresh!)).not.toBeNull();
  await sessions.logout(active!);
  await sessions.logout(fresh!);
});
