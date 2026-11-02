// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  namedRecordService,
  ledgerService,
  type NamedTable,
} from '@finmichi/core';
import { fixture } from './catalog-fixture.js';
export function namedContract(resource: NamedTable) {
  let f: Awaited<ReturnType<typeof fixture>>, id: string;
  const path = () => `/api/ledgers/${f.ledger}/${resource}`;
  const payload = (name: string) => ({
    name,
    ...(resource === 'memo_templates' ? { memo: 'Synthetic memo' } : {}),
  });
  beforeAll(async () => {
    f = await fixture(resource);
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  it('requires real session and same Origin; isolates each operation and core by owner', async () => {
    expect((await f.app.inject(path())).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: path(),
          headers: { ...f.headers, origin: 'https://evil.invalid' },
          payload: payload('Denied'),
        })
      ).statusCode,
    ).toBe(403);
    const own = await namedRecordService(f.db, resource).create(
      f.actor,
      f.ledger,
      payload('Synthetic ownership'),
    );
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      const r = await f.app.inject({
        method,
        url: ['PATCH', 'DELETE'].includes(method)
          ? `${path()}/${own.id}`
          : path(),
        headers: f.otherHeaders,
        ...(['POST', 'PATCH'].includes(method)
          ? { payload: payload('Denied') }
          : {}),
      });
      expect(r.statusCode).toBe(404);
    }
    const [u] =
      await f.db`SELECT id FROM users WHERE oidc_issuer=${`https://${resource}.synthetic.invalid`} AND oidc_subject='stranger'`;
    await expect(
      namedRecordService(f.db, resource).remove(
        String(u!.id),
        f.ledger,
        own.id,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it('creates, reads, lists and renames trimmed records', async () => {
    const created = await f.app.inject({
      method: 'POST',
      url: path(),
      headers: f.headers,
      payload: payload('  Synthetic editable  '),
    });
    expect(created.statusCode).toBe(201);
    id = String(created.json().id);
    expect(created.json()).toMatchObject({
      name: 'Synthetic editable',
      archived: false,
    });
    const updated = await f.app.inject({
      method: 'PATCH',
      url: `${path()}/${id}`,
      headers: f.headers,
      payload: { name: 'Synthetic renamed' },
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (
        await f.app.inject({ url: `${path()}/${id}`, headers: f.headers })
      ).json(),
    ).toEqual(updated.json());
    expect(
      (await namedRecordService(f.db, resource).list(f.actor, f.ledger)).some(
        (r) => r.id === id,
      ),
    ).toBe(true);
  });
  it('strictly rejects unknown/empty fields, malformed IDs and queries', async () => {
    for (const invalid of [
      { name: ' ' },
      { name: 'x', ledger_id: f.ledger },
      { name: 'x', archived: 'false' },
      { name: 'x', owner_id: f.actor },
    ]) {
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: path(),
            headers: f.headers,
            payload: invalid,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `${path()}/${id}`,
          headers: f.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await f.app.inject({ url: path() + '/bad-id', headers: f.headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          url: path() + '?include_archived=yes',
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await f.app.inject({ url: path() + '?unknown=1', headers: f.headers }))
        .statusCode,
    ).toBe(400);
    expect(() =>
      namedRecordService(f.db, 'transactions' as NamedTable),
    ).toThrow('invalid_input');
  });
  it('case-insensitive names are unique per ledger and foreign IDs cannot cross ledgers', async () => {
    const duplicate = await f.app.inject({
      method: 'POST',
      url: path(),
      headers: f.headers,
      payload: payload('synthetic RENAMED'),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'duplicate_name' });
    const other = await ledgerService(f.db).create(f.actor, {
      name: `Synthetic ${resource} other ledger`,
    });
    const foreign = await namedRecordService(f.db, resource).create(
      f.actor,
      other.id,
      payload('Synthetic renamed'),
    );
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      expect(
        (
          await f.app.inject({
            method,
            url: `${path()}/${foreign.id}`,
            headers: f.headers,
            ...(method === 'PATCH' ? { payload: { name: 'Denied' } } : {}),
          })
        ).statusCode,
      ).toBe(404);
    }
  });
  it('archives without resetting omitted fields, filters active list, restores and reads archived history', async () => {
    const archived = await f.app.inject({
      method: 'PATCH',
      url: `${path()}/${id}`,
      headers: f.headers,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      name: 'Synthetic renamed',
      archived: true,
    });
    expect(
      (await namedRecordService(f.db, resource).list(f.actor, f.ledger)).map(
        (r) => r.id,
      ),
    ).not.toContain(id);
    expect(
      (await namedRecordService(f.db, resource).get(f.actor, f.ledger, id))
        .archived,
    ).toBe(true);
    expect(
      (
        await namedRecordService(f.db, resource).list(f.actor, f.ledger, {
          include_archived: 'true',
        })
      ).map((r) => r.id),
    ).toContain(id);
    await namedRecordService(f.db, resource).update(f.actor, f.ledger, id, {
      archived: false,
    });
  });
  it('deletes unreferenced records, safely returns missing on repeated delete and audits no payload', async () => {
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `${path()}/${id}`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `${path()}/${id}`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(404);
    const rows =
      await f.db`SELECT action,outcome FROM audit_logs WHERE user_id=${f.actor} AND action=${`${resource}.delete`}`;
    expect(rows).toContainEqual({
      action: `${resource}.delete`,
      outcome: 'success',
    });
    expect(JSON.stringify(rows)).not.toContain('Synthetic');
  });
  it('preserves transaction history when archiving references or deleting a copied memo template', async () => {
    const r = await namedRecordService(f.db, resource).create(
      f.actor,
      f.ledger,
      payload('Synthetic referenced'),
    );
    await f.db.begin(async (sql) => {
      const [a, b] =
        await sql`INSERT INTO items(ledger_id,kind,name,currency) VALUES (${f.ledger},'asset','Synthetic cash','TWD'),(${f.ledger},'expense','Synthetic expense','TWD') RETURNING id`;
      const column = resource === 'payees' ? 'payee_id' : 'project_id';
      const [tx] =
        await sql`INSERT INTO transactions ${sql({ ledger_id: f.ledger, occurred_on: '2026-01-01', kind: 'expense', ...(resource === 'memo_templates' ? { memo: r.memo! } : { [column]: r.id }) })} RETURNING id`;
      await sql`INSERT INTO transaction_entries(ledger_id,transaction_id,item_id,amount,currency,exchange_rate,base_amount) VALUES (${f.ledger},${tx!.id},${a!.id},'-1','TWD','1','-1'),(${f.ledger},${tx!.id},${b!.id},'1','TWD','1','1')`;
    });
    const deleted = await f.app.inject({
      method: 'DELETE',
      url: `${path()}/${r.id}`,
      headers: f.headers,
    });
    if (resource === 'memo_templates') {
      expect(deleted.statusCode).toBe(204);
      const [tx] =
        await f.db`SELECT memo FROM transactions WHERE ledger_id=${f.ledger}`;
      expect(tx!.memo).toBe('Synthetic memo');
      return;
    }
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toEqual({ error: 'in_use' });
    expect(
      (
        await namedRecordService(f.db, resource).update(
          f.actor,
          f.ledger,
          r.id,
          { archived: true },
        )
      ).archived,
    ).toBe(true);
    expect(
      await f.db`SELECT id FROM transactions WHERE ledger_id=${f.ledger}`,
    ).toHaveLength(1);
  });
}
