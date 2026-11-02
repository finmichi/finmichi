// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { fixture } from '../test/catalog-fixture.js';
import { createApp } from './app.js';
import {
  tokenHash,
  ledgerService,
  sessionService,
  restoreService,
  reportService,
  deletionLedgerTables,
  deletionSchemaTables,
  dataResetService,
} from '@finmichi/core';
import { seedDeletionLedger } from '../../../scripts/data-reset-fixture.mjs';
import { syntheticReauthProvider } from '../../../scripts/data-reset-oidc.mjs';
import type { Database } from '@finmichi/db';
import type { LedgerBackup } from '@finmichi/core/backup-schemas';
let f: Awaited<ReturnType<typeof fixture>>,
  seeded: Awaited<ReturnType<typeof seedDeletionLedger>>,
  otherLedger: string,
  sameOwner: string;
const raw = (headers = f.headers) => headers.cookie.slice('session='.length);
const post = (path: string, payload: unknown = {}, headers = f.headers) =>
  f.app.inject({ method: 'POST', url: path, headers, payload });
const base = () => `/api/ledgers/${f.ledger}/purge`;
const fresh = () =>
  f.db`UPDATE sessions SET reauthenticated=true,authenticated_at=clock_timestamp() WHERE token_hash=${tokenHash(raw())}`;
async function preview() {
  const r = await post(base() + '-preview');
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function backup(p: { backup_token: string }, ledger = f.ledger) {
  return post(`/api/ledgers/${ledger}/backup.json`, {
    backup_token: p.backup_token,
  });
}
const confirm = async (p: { backup_token: string }, patch = {}) =>
  post(base(), {
    backup_token: p.backup_token,
    confirmation: 'data-reset synthetic',
    ...patch,
  });
async function counts(ledger: string) {
  return Object.fromEntries(
    await Promise.all(
      deletionLedgerTables.map(async (t) => [
        t,
        Number(
          (
            await f.db`SELECT count(*)::integer AS n FROM ${f.db(t)} WHERE ledger_id=${ledger}`
          )[0]!.n,
        ),
      ]),
    ),
  );
}
beforeAll(async () => {
  f = await fixture('data-reset', { allowFactoryReset: true });
  seeded = await seedDeletionLedger(f.db, f.actor, f.ledger);
  const other = (await sessionService(f.db, ['owner', 'stranger']).authenticate(
    raw(f.otherHeaders),
  ))!.id;
  otherLedger = (
    await ledgerService(f.db).create(other, { name: '合成他人完整帳本' })
  ).id;
  await seedDeletionLedger(f.db, other, otherLedger);
  sameOwner = (
    await ledgerService(f.db).create(f.actor, { name: '合成同人另一帳本' })
  ).id;
  await f.db`UPDATE ledgers SET locked_until='2026-10-31' WHERE id=${f.ledger}`;
  await fresh();
});
afterAll(async () => {
  if (f) await f.close();
});

it('classifies every real public table and seeds every ledger-owned table, including non-backup state', async () => {
  const tables =
    await f.db`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`;
  expect(tables.map((t) => t.table_name)).toEqual(deletionSchemaTables);
  const p = await preview(),
    actual = await counts(f.ledger);
  for (const table of deletionLedgerTables) {
    expect(actual[table], table).toBeGreaterThan(0);
    expect(p.counts[table], table).toBe(actual[table]);
  }
  expect(p.ledgers[0].locked_until).toBe('2026-10-31');
  const [grant] =
    await f.db`SELECT * FROM data_reset_grants WHERE user_id=${f.actor}`;
  expect(grant!.token_hash).toBe(tokenHash(p.backup_token));
  expect(JSON.stringify(grant)).not.toContain(p.backup_token);
  expect(Object.keys(grant!.backups)).toEqual([]);
});
it('requires a session for direct core access and denies foreign ledgers in preview and execution', async () => {
  await expect(
    dataResetService(f.db, true).execute(f.actor, undefined, 'factory', {
      confirmation: 'RESET',
    }),
  ).rejects.toMatchObject({ code: 'browser_session_required' });
  for (const suffix of ['-preview', ''])
    expect(
      (
        await post(
          base() + suffix,
          suffix ? {} : { confirmation: 'data-reset synthetic' },
          f.otherHeaders,
        )
      ).statusCode,
    ).toBe(404);
  expect((await post(base() + '-preview', {}, f.otherHeaders)).statusCode).toBe(
    404,
  );
});
it('requires a token and does not count an ordinary backup GET as a deletion backup', async () => {
  expect(
    (await post(base(), { confirmation: 'data-reset synthetic' })).json(),
  ).toEqual({ error: 'backup_token_required' });
  const p = await preview();
  expect(
    (
      await f.app.inject({
        url: `/api/ledgers/${f.ledger}/backup.json`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(200);
  expect((await confirm(p)).json()).toEqual({ error: 'backup_required' });
});
it('rejects another ledger token, another owner, malformed/expired tokens and forged completion fields', async () => {
  const p = await preview();
  expect(
    (
      await post(`/api/ledgers/${sameOwner}/purge`, {
        backup_token: p.backup_token,
        confirmation: '合成同人另一帳本',
      })
    ).json(),
  ).toEqual({ error: 'backup_token_invalid' });
  expect((await backup(p, sameOwner)).json()).toEqual({
    error: 'backup_token_invalid',
  });
  expect(
    (await confirm(p, { backups: { [f.ledger]: 'a'.repeat(64) } })).statusCode,
  ).toBe(400);
  expect((await confirm(p, { backup_token: 'invalid' })).statusCode).toBe(400);
  await f.db`UPDATE data_reset_grants SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE user_id=${f.actor}`;
  expect((await confirm(p)).json()).toEqual({ error: 'backup_token_invalid' });
  expect((await backup(p)).json()).toEqual({ error: 'backup_token_invalid' });
});
it('rejects incorrect confirmation and stale data even when row counts have not changed', async () => {
  const p = await preview();
  expect((await backup(p)).statusCode).toBe(200);
  expect((await confirm(p, { confirmation: 'RESET' })).json()).toEqual({
    error: 'confirmation_mismatch',
  });
  await f.db`UPDATE transactions SET memo='SYNTHETIC_CHANGED_AFTER_BACKUP' WHERE id=${seeded.tx.id}`;
  expect((await confirm(p)).json()).toEqual({ error: 'preview_changed' });
  expect((await backup(p)).json()).toEqual({ error: 'preview_changed' });
  await f.db`UPDATE transactions SET memo='SYNTHETIC_RESET_MEMO' WHERE id=${seeded.tx.id}`;
});
it.each(['normal', 'old', 'future', 'legacy'])(
  'requires forced recent authentication: %s',
  async (kind) => {
    const p = await preview();
    if (kind === 'normal')
      await f.db`UPDATE sessions SET reauthenticated=false,authenticated_at=now() WHERE token_hash=${tokenHash(raw())}`;
    if (kind === 'old')
      await f.db`UPDATE sessions SET authenticated_at=now()-interval '6 minutes' WHERE token_hash=${tokenHash(raw())}`;
    if (kind === 'future')
      await f.db`UPDATE sessions SET authenticated_at=now()+interval '1 minute' WHERE token_hash=${tokenHash(raw())}`;
    if (kind === 'legacy')
      await f.db`UPDATE sessions SET authenticated_at=NULL WHERE token_hash=${tokenHash(raw())}`;
    try {
      expect((await confirm(p)).json()).toEqual({ error: 'reauth_required' });
    } finally {
      await fresh();
    }
  },
);
it('rejects PAT-only, mixed PAT/cookie, foreign Origin and missing Origin on every new mutation', async () => {
  for (const path of [
    base(),
    base() + '-preview',
    '/api/factory-reset',
    '/api/factory-reset-preview',
    `/api/ledgers/${f.ledger}/backup.json`,
  ]) {
    const bearer = {
      origin: f.headers.origin,
      authorization: 'Bearer ' + seeded.pat.token,
    };
    expect((await post(path, {}, bearer as typeof f.headers)).statusCode).toBe(
      401,
    );
    expect((await post(path, {}, { ...f.headers, ...bearer })).json()).toEqual({
      error: 'browser_session_required',
    });
    expect(
      (
        await post(
          path,
          {},
          { ...f.headers, origin: 'https://foreign.invalid' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await post(path, {}, { cookie: f.headers.cookie } as typeof f.headers))
        .statusCode,
    ).toBe(403);
  }
});
it('offers no MCP purge/reset tool through the official SDK', async () => {
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({
    name: 'synthetic-deletion-boundary',
    version: '1',
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(address + '/mcp'),
    {
      requestInit: { headers: { Authorization: 'Bearer ' + seeded.pat.token } },
    },
  );
  const before = await counts(f.ledger);
  try {
    await client.connect(transport as unknown as Transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ['ledger_purge', 'factory_reset']) {
      expect(names).not.toContain(name);
      const result = await client
        .callTool({ name, arguments: { ledger_id: f.ledger } })
        .catch(() => ({ isError: true }));
      expect(result.isError).toBe(true);
    }
    expect(await counts(f.ledger)).toEqual(before);
  } finally {
    await client.close();
  }
});
it('does not reuse transaction-start time when reauthentication expires while waiting for a user lock', async () => {
  const p = await preview();
  expect((await backup(p)).statusCode).toBe(200);
  let unlock!: () => void, locked!: () => void;
  const acquired = new Promise<void>((r) => {
      locked = r;
    }),
    release = new Promise<void>((r) => {
      unlock = r;
    });
  const blocker = f.db.begin(async (sql) => {
    await sql`SELECT id FROM users WHERE id=${f.actor} FOR NO KEY UPDATE`;
    locked();
    await release;
  });
  await acquired;
  await f.db`UPDATE sessions SET authenticated_at=clock_timestamp()-interval '5 minutes'+interval '300 milliseconds' WHERE token_hash=${tokenHash(raw())}`;
  const result = dataResetService(f.db, true).execute(
    f.actor,
    raw(),
    'purge',
    { backup_token: p.backup_token, confirmation: 'data-reset synthetic' },
    f.ledger,
  );
  await delay(450);
  unlock();
  await blocker;
  try {
    await expect(result).rejects.toMatchObject({ code: 'reauth_required' });
  } finally {
    await fresh();
  }
});
it('fails closed when any new table is not classified, without deleting any data', async () => {
  const p = await preview(),
    before = await counts(f.ledger);
  await f.db`CREATE TABLE synthetic_unclassified(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id))`;
  try {
    expect((await post(base() + '-preview')).json()).toEqual({
      error: 'deletion_schema_incomplete',
    });
    expect((await confirm(p)).json()).toEqual({
      error: 'deletion_schema_incomplete',
    });
    expect(await counts(f.ledger)).toEqual(before);
  } finally {
    await f.db`DROP TABLE synthetic_unclassified`;
  }
});
it('rolls back every ledger table, grant consumption and audit when the final audit insert fails', async () => {
  const p = await preview();
  expect((await backup(p)).statusCode).toBe(200);
  const before = await counts(f.ledger),
    grants =
      await f.db`SELECT * FROM data_reset_grants WHERE user_id=${f.actor}`,
    audits =
      await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} ORDER BY id`;
  await f.db.unsafe(
    `CREATE FUNCTION synthetic_abort_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ledger.purge' AND NEW.user_id='${f.actor}'::uuid THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_abort_reset BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION synthetic_abort_reset()`,
  );
  try {
    expect((await confirm(p)).statusCode).toBe(500);
    expect(await counts(f.ledger)).toEqual(before);
    expect(
      await f.db`SELECT * FROM data_reset_grants WHERE user_id=${f.actor}`,
    ).toEqual(grants);
    expect(
      await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} ORDER BY id`,
    ).toEqual(audits);
  } finally {
    await f.db`DROP TRIGGER synthetic_abort_reset ON audit_logs`;
    await f.db`DROP FUNCTION synthetic_abort_reset()`;
  }
});
it('uses real OIDC PKCE/nonce/signature, prompt=login and account binding for recent-auth sessions', async () => {
  const staleGrant = await preview();
  expect((await backup(staleGrant)).statusCode).toBe(200);
  const issuer = 'https://data-reset.synthetic.invalid',
    provider = await syntheticReauthProvider(issuer);
  const app = await createApp(
    {
      databaseUrl: process.env.TEST_DATABASE_URL!,
      publicUrl: f.headers.origin,
      issuer,
      clientId: 'synthetic',
      allowedSubjects: ['owner', 'stranger'],
      trustProxy: 0,
      version: 'test',
      mockInternalUrl: provider.url,
    },
    f.db,
  );
  const login = async () => {
    const start = await app.inject({
      url: '/auth/login?reauth=1&return_to=%2Fadmin%2Fledgers',
      headers: f.headers,
    });
    expect(start.statusCode).toBe(302);
    const binding = start.cookies.find((c) => c.name === 'oidc_flow')!.value;
    const redirect = await fetch(String(start.headers.location), {
      redirect: 'manual',
    });
    const target = new URL(redirect.headers.get('location')!);
    return app.inject({
      url: target.pathname + target.search,
      headers: { cookie: f.headers.cookie + '; oidc_flow=' + binding },
    });
  };
  try {
    expect((await app.inject('/auth/login?reauth=1')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/auth/login?reauth=1&return_to=https://foreign.invalid',
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(400);
    const old = raw(),
      ok = await login();
    expect(ok.statusCode, ok.body).toBe(302);
    expect(ok.headers.location).toBe('/admin/ledgers');
    expect(provider.prompts.at(-1)).toBe('login');
    const token = ok.cookies.find((c) => c.name === 'session')!.value;
    f.headers.cookie = 'session=' + token;
    expect(
      await f.db`SELECT token_hash FROM sessions WHERE token_hash=${tokenHash(old)}`,
    ).toHaveLength(0);
    expect(
      (await dataResetService(f.db, true).status(f.actor, token)).recent_auth,
    ).toBe(true);
    expect((await confirm(staleGrant)).json()).toEqual({
      error: 'backup_token_invalid',
    });
    provider.setSubject('stranger');
    expect((await login()).json()).toEqual({
      error: 'reauth_identity_mismatch',
    });
    expect(
      (await f.app.inject({ url: '/api/me', headers: f.headers })).json().user
        .id,
    ).toBe(f.actor);
  } finally {
    await app.close();
    await provider.close();
  }
});
function normalized(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value))
    return value
      .map((v) => normalized(v, ids))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== 'generated_at')
        .map(([k, v]) => [k, normalized(v, ids)]),
    );
  return value;
}
async function restoreProof(
  db: Database,
  actor: string,
  payload: LedgerBackup,
  before: unknown,
  name: string,
) {
  const reports = reportService(db),
    dates = { date_from: '2026-01-01', date_to: '2026-12-31' };
  const restored = await restoreService(db).confirm(actor, payload, { name }),
    newLedger = restored.ledger.id;
  const rows =
    await db`SELECT id,name,kind FROM items WHERE ledger_id=${newLedger}`;
  const mapping = new Map<string, string>([
    [payload.ledger.id, newLedger],
    ...payload.tables.items.map(
      (i) =>
        [
          i.id,
          String(rows.find((r) => r.name === i.name && r.kind === i.kind)!.id),
        ] as [string, string],
    ),
  ]);
  const securities =
    await db`SELECT id,symbol,market,item_id FROM securities WHERE ledger_id=${newLedger}`;
  for (const security of payload.tables.securities)
    mapping.set(
      security.id,
      String(
        securities.find(
          (s) =>
            s.symbol === security.symbol &&
            s.market === security.market &&
            s.item_id === mapping.get(security.item_id),
        )!.id,
      ),
    );
  const after = [
    await reports.income(actor, newLedger, { ...dates, grain: 'month' }),
    await reports.category(actor, newLedger, { ...dates, kind: 'expense' }),
    await reports.balance(actor, newLedger, { as_of: '2026-12-31' }),
  ];
  expect(normalized(before, mapping)).toEqual(normalized(after, new Map()));
}
it('purges all ledger data despite a lock, preserves other data/audit and restores its downloaded backup with identical reports', async () => {
  await fresh();
  const p = await preview(),
    file = await backup(p);
  expect(file.statusCode, file.body).toBe(200);
  const payload = file.json<LedgerBackup>(),
    reports = reportService(f.db),
    dates = { date_from: '2026-01-01', date_to: '2026-12-31' };
  const before = [
    await reports.income(f.actor, f.ledger, { ...dates, grain: 'month' }),
    await reports.category(f.actor, f.ledger, { ...dates, kind: 'expense' }),
    await reports.balance(f.actor, f.ledger, { as_of: '2026-12-31' }),
  ];
  const other = await counts(otherLedger),
    auditBefore = (
      await f.db`SELECT count(*)::integer n FROM audit_logs WHERE user_id=${f.actor}`
    )[0]!.n;
  const done = await confirm(p);
  expect(done.statusCode, done.body).toBe(200);
  expect(Object.values(await counts(f.ledger)).every((n) => n === 0)).toBe(
    true,
  );
  expect(await f.db`SELECT id FROM ledgers WHERE id=${f.ledger}`).toHaveLength(
    0,
  );
  expect(await counts(otherLedger)).toEqual(other);
  expect(await f.db`SELECT id FROM ledgers WHERE id=${sameOwner}`).toHaveLength(
    1,
  );
  const audit =
    await f.db`SELECT * FROM audit_logs WHERE user_id=${f.actor} ORDER BY id DESC LIMIT 1`;
  expect(audit[0]!.action).toBe('ledger.purge');
  expect(audit[0]!.deleted_counts).toEqual(p.counts);
  expect(audit[0]!.duration_ms).toBeGreaterThanOrEqual(0);
  expect(
    (
      await f.db`SELECT count(*)::integer n FROM audit_logs WHERE user_id=${f.actor}`
    )[0]!.n,
  ).toBe(auditBefore + 1);
  for (const forbidden of [
    'SYNTHETIC_RESET_MEMO',
    'SYNTHETIC_RESET_DRAFT',
    p.backup_token,
    seeded.pat.token,
    '"amount":',
    '"memo":',
    'cookie',
  ])
    expect(JSON.stringify(audit)).not.toContain(forbidden);
  await restoreProof(f.db, f.actor, payload, before, '合成刪除後完整還原');
  const second = await post(`/api/ledgers/${sameOwner}/purge-preview`),
    secondFile = await backup(second.json(), sameOwner);
  expect(secondFile.statusCode).toBe(200);
  const limited = await post(`/api/ledgers/${sameOwner}/purge`, {
    backup_token: second.json().backup_token,
    confirmation: '合成同人另一帳本',
  });
  expect(limited.statusCode).toBe(429);
  expect(limited.json()).toEqual({ error: 'reset_rate_limited' });
});
it('factory reset is disabled by default, including preview and capability discovery', async () => {
  const off = await fixture('factory-off');
  try {
    for (const path of ['/api/factory-reset', '/api/factory-reset-preview'])
      expect(
        (
          await off.app.inject({
            method: 'POST',
            url: path,
            headers: off.headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (await off.app.inject({ url: '/api/me', headers: off.headers })).json()
        .safety.factory_reset,
    ).toBe(false);
  } finally {
    await off.close();
  }
});
it('factory reset requires every backup, is race-safe, retains current session/user/global data, and never affects another owner', async () => {
  const a = await fixture('factory-all-' + randomUUID(), {
    allowFactoryReset: true,
  });
  try {
    await seedDeletionLedger(a.db, a.actor, a.ledger);
    const extra = await ledgerService(a.db).create(a.actor, {
        name: '合成第二帳本',
      }),
      stranger = (await sessionService(a.db, [
        'owner',
        'stranger',
      ]).authenticate(raw(a.otherHeaders)))!.id;
    const other = await ledgerService(a.db).create(stranger, {
      name: '合成不可刪他人',
    });
    await seedDeletionLedger(a.db, stranger, other.id);
    const [old] =
      await a.db`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (${tokenHash(randomUUID())},${a.actor},now()+interval '1 day') RETURNING token_hash`;
    expect(old).toBeDefined();
    await a.db`UPDATE sessions SET reauthenticated=true,authenticated_at=clock_timestamp() WHERE token_hash=${tokenHash(raw(a.headers))}`;
    await a.db`INSERT INTO market_fx_rates(rate_date,currency,spot_buy,spot_sell,source) VALUES ('2099-01-02','USD','30','31','bot') ON CONFLICT DO NOTHING`;
    await a.db`INSERT INTO market_prices(trade_date,market,symbol,close,source) VALUES ('2099-01-02','TWSE','ZZZ9','10','twse') ON CONFLICT DO NOTHING`;
    await a.db`INSERT INTO market_calendar(date,market,is_trading_day,source) VALUES ('2099-01-02','TWSE',true,'twse') ON CONFLICT DO NOTHING`;
    await a.db`INSERT INTO market_fetch_runs(source) VALUES ('calendar') ON CONFLICT DO NOTHING`;
    const globalBefore = await Promise.all(
      [
        'market_fx_rates',
        'market_prices',
        'market_calendar',
        'market_fetch_runs',
      ].map(
        (t) =>
          a.db`SELECT to_jsonb(t) AS row FROM ${a.db(t)} t ORDER BY to_jsonb(t)::text`,
      ),
    );
    const snapshot = await counts(other.id);
    const req = (path: string, payload: unknown) =>
      a.app.inject({ method: 'POST', url: path, headers: a.headers, payload });
    const p = (await req('/api/factory-reset-preview', {})).json();
    expect(p.ledgers).toHaveLength(2);
    const payload = { backup_token: p.backup_token, confirmation: 'RESET' };
    expect((await req('/api/factory-reset', payload)).json()).toEqual({
      error: 'backup_required',
    });
    const backups: { payload: LedgerBackup; before: unknown }[] = [];
    for (const id of [a.ledger, extra.id]) {
      const file = await req(`/api/ledgers/${id}/backup.json`, {
        backup_token: p.backup_token,
      });
      expect(file.statusCode, file.body).toBe(200);
      const reports = reportService(a.db),
        dates = { date_from: '2026-01-01', date_to: '2026-12-31' };
      backups.push({
        payload: file.json<LedgerBackup>(),
        before: [
          await reports.income(a.actor, id, { ...dates, grain: 'month' }),
          await reports.category(a.actor, id, { ...dates, kind: 'expense' }),
          await reports.balance(a.actor, id, { as_of: '2026-12-31' }),
        ],
      });
    }
    const both = await Promise.all([
      req('/api/factory-reset', payload),
      req('/api/factory-reset', payload),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 429]);
    for (const id of [a.ledger, extra.id])
      expect(Object.values(await counts(id)).every((n) => n === 0)).toBe(true);
    expect(
      await a.db`SELECT id FROM ledgers WHERE owner_id=${a.actor}`,
    ).toHaveLength(0);
    for (const t of ['personal_access_tokens', 'data_reset_grants'])
      expect(
        await a.db`SELECT 1 FROM ${a.db(t)} WHERE user_id=${a.actor}`,
      ).toHaveLength(0);
    expect(
      await a.db`SELECT token_hash FROM sessions WHERE user_id=${a.actor}`,
    ).toEqual([{ token_hash: tokenHash(raw(a.headers)) }]);
    expect(await a.db`SELECT id FROM users WHERE id=${a.actor}`).toHaveLength(
      1,
    );
    expect(await counts(other.id)).toEqual(snapshot);
    expect(
      await Promise.all(
        [
          'market_fx_rates',
          'market_prices',
          'market_calendar',
          'market_fetch_runs',
        ].map(
          (t) =>
            a.db`SELECT to_jsonb(t) AS row FROM ${a.db(t)} t ORDER BY to_jsonb(t)::text`,
        ),
      ),
    ).toEqual(globalBefore);
    for (const [i, b] of backups.entries())
      await restoreProof(
        a.db,
        a.actor,
        b.payload,
        b.before,
        '合成重置後還原 ' + i,
      );
    expect(
      (await a.app.inject({ url: '/api/me', headers: a.headers })).statusCode,
    ).toBe(200);
    expect(
      (await a.app.inject({ url: '/api/me', headers: a.otherHeaders }))
        .statusCode,
    ).toBe(200);
  } finally {
    await a.close();
  }
});
