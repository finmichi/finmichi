// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { patService, hashPat } from '@finmichi/core';
import { fixture } from '../test/catalog-fixture.js';
describe('personal access tokens', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture('pat-management');
  });
  afterAll(async () => {
    await f.close();
  });
  it('creates read-only, scoped and masked secrets once; hash only; own access and revoke', async () => {
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/pats',
      headers: f.headers,
      payload: { expires_in_days: 1, ledger_ids: [f.ledger] },
    });
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const p = r.json();
    expect(p.token).toMatch(/^llp_[A-Za-z0-9_-]{43}$/);
    expect(p.mask_text).toBe(true);
    expect(p.scope).toBe('read');
    expect(p.token_prefix).toBe(p.token.slice(0, 8));
    const [stored] =
      await f.db`SELECT * FROM personal_access_tokens WHERE id=${p.id}`;
    expect(stored!.token_hash).toBe(hashPat(p.token));
    expect(JSON.stringify(stored)).not.toContain(p.token);
    const list = await f.app.inject({ url: '/api/pats', headers: f.headers });
    expect(list.body).not.toContain(p.token);
    expect(list.body).not.toContain(stored!.token_hash);
    const svc = patService(f.db);
    expect((await svc.authenticate(p.token))?.ledger_ids).toEqual([f.ledger]);
    expect(await svc.authenticate('bad')).toBeNull();
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/pats/' + p.id + '/revoke',
          headers: f.otherHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/pats/' + p.id + '/revoke',
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(await svc.authenticate(p.token)).toBeNull();
    const logs =
      await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} AND action LIKE 'pat.%'`;
    expect(logs.map((x) => x.action)).toContain('pat.create');
    expect(logs.map((x) => x.action)).toContain('pat.revoke');
    expect(JSON.stringify(logs)).not.toContain(p.token);
    expect(JSON.stringify(logs)).not.toContain(stored!.token_hash);
  });
  it('owner creation lock permits concurrent audit foreign-key checks', async () => {
    const svc = patService(f.db);
    let pending: ReturnType<typeof svc.create> | undefined;
    let completedWhileHeld = false;
    await f.db.begin(async (operation) => {
      // FK checks hold KEY SHARE; PAT creation must finish before this releases it.
      await operation`SELECT id FROM users WHERE id=${f.actor} FOR KEY SHARE`;
      let finished = false;
      pending = svc.create(f.actor, { expires_in_days: 1 });
      await Promise.race([
        pending.then(() => {
          finished = true;
        }),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      completedWhileHeld = finished;
    });
    const created = await pending!;
    await svc.revoke(f.actor, created.id);
    expect(completedWhileHeld).toBe(true);
  });
  it('rejects invalid durations, write scope, unknown fields and foreign ledger', async () => {
    for (const payload of [
      { expires_in_days: 0 },
      { expires_in_days: 91 },
      { expires_in_days: 1.5 },
      { expires_in_days: 1, scope: 'write' },
      { expires_in_days: 1, token: 'forbidden' },
      { expires_in_days: 1, ledger_ids: [] },
    ])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/pats',
            headers: f.headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/pats',
          headers: f.otherHeaders,
          payload: { expires_in_days: 1, ledger_ids: [f.ledger] },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/pats',
          headers: { ...f.headers, origin: 'https://evil.invalid' },
          payload: { expires_in_days: 1 },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('serializes concurrent creation to ten active tokens; expiry is immediate', async () => {
    const svc = patService(f.db);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        svc.create(f.actor, { expires_in_days: 90 }),
      ),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(10);
    const p = (
      results.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof svc.create>>
      >
    ).value;
    // Shift both timestamps to preserve DB lifetime constraint while simulating expiry.
    await f.db`UPDATE personal_access_tokens SET created_at=now()-interval '91 days',expires_at=now()-interval '1 day' WHERE id=${p.id}`;
    expect(await svc.authenticate(p.token)).toBeNull();
    expect(
      (await svc.create(f.actor, { expires_in_days: 1, mask_text: false }))
        .mask_text,
    ).toBe(false);
  });
});
