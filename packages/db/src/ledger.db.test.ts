// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, expect, it } from 'vitest';
import { connect, migrate } from './index.js';
if (!process.env.TEST_DATABASE_URL)
  throw new Error('TEST_DATABASE_URL required');
const db = connect(process.env.TEST_DATABASE_URL);
let ledger: string, other: string, cash: string, expense: string, usd: string;
beforeAll(async () => {
  await migrate(db);
  const [u] =
    await db`INSERT INTO users(oidc_issuer,oidc_subject) VALUES ('https://schema.synthetic.invalid','schema-test') RETURNING id`;
  const [l] =
    await db`INSERT INTO ledgers(owner_id,name) VALUES (${u!.id},'Synthetic ledger') RETURNING id`;
  const [o] =
    await db`INSERT INTO ledgers(owner_id,name) VALUES (${u!.id},'Synthetic other') RETURNING id`;
  ledger = String(l!.id);
  other = String(o!.id);
  const [a] =
    await db`INSERT INTO items(ledger_id,kind,name,currency) VALUES (${ledger},'asset','Cash','TWD') RETURNING id`;
  const [e] =
    await db`INSERT INTO items(ledger_id,kind,name,currency) VALUES (${ledger},'expense','Food','TWD') RETURNING id`;
  const [f] =
    await db`INSERT INTO items(ledger_id,kind,name,currency) VALUES (${ledger},'asset','USD cash','USD') RETURNING id`;
  cash = String(a!.id);
  expense = String(e!.id);
  usd = String(f!.id);
});
afterAll(async () => {
  await db.end();
});
interface Entry {
  item: string;
  amount: string;
  currency?: string;
  rate?: string;
  base?: string;
}
async function write(entries: Entry[], kind = 'expense') {
  return db.begin(async (sql) => {
    const [tx] =
      await sql`INSERT INTO transactions(ledger_id,occurred_on,kind) VALUES (${ledger},'2026-01-02',${kind}) RETURNING id`;
    for (const e of entries)
      await sql`INSERT INTO transaction_entries(ledger_id,transaction_id,item_id,amount,currency,exchange_rate,base_amount) VALUES (${ledger},${tx!.id},${e.item},${e.amount},${e.currency ?? 'TWD'},${e.rate ?? '1'},${e.base ?? e.amount})`;
    return String(tx!.id);
  });
}
it('commits exact decimal zero including 0.1+0.2, and stores date without timezone shift', async () => {
  const id = await write([
    { item: cash, amount: '-0.3' },
    { item: expense, amount: '0.1' },
    { item: expense, amount: '0.2' },
  ]);
  const [r] =
    await db`SELECT sum(base_amount)::text AS total FROM transaction_entries WHERE transaction_id=${id}`;
  expect(r!.total).toBe('0.000000');
  const [tx] =
    await db`SELECT occurred_on::text AS day FROM transactions WHERE id=${id}`;
  expect(tx!.day).toBe('2026-01-02');
});
it.each(['empty', 'single', 'unbalanced'])(
  'rejects %s transaction at commit and rolls back its parent',
  async (mode) => {
    const before = await db`SELECT count(*)::int AS count FROM transactions`;
    const entries: Entry[] =
      mode === 'empty'
        ? []
        : mode === 'single'
          ? [{ item: cash, amount: '1' }]
          : [
              { item: cash, amount: '-1' },
              { item: expense, amount: '1.01' },
            ];
    await expect(write(entries)).rejects.toThrow('exact zero');
    expect(await db`SELECT count(*)::int AS count FROM transactions`).toEqual(
      before,
    );
  },
);
it('rejects unbalanced entry update/delete/move; accepts balanced replacement and parent deletion', async () => {
  const id = await write([
    { item: cash, amount: '-1' },
    { item: expense, amount: '1' },
  ]);
  const target = await write([
    { item: cash, amount: '-2' },
    { item: expense, amount: '2' },
  ]);
  const [entry] =
    await db`SELECT id FROM transaction_entries WHERE transaction_id=${id} AND item_id=${cash}`;
  await expect(
    db`UPDATE transaction_entries SET base_amount='-2' WHERE id=${entry!.id}`,
  ).rejects.toThrow('exact zero');
  await expect(
    db`DELETE FROM transaction_entries WHERE id=${entry!.id}`,
  ).rejects.toThrow('exact zero');
  await expect(
    db`UPDATE transaction_entries SET transaction_id=${target} WHERE id=${entry!.id}`,
  ).rejects.toThrow('exact zero');
  await db.begin(async (sql) => {
    await sql`DELETE FROM transaction_entries WHERE transaction_id=${id}`;
    await sql`INSERT INTO transaction_entries(ledger_id,transaction_id,item_id,amount,currency,exchange_rate,base_amount) VALUES (${ledger},${id},${cash},'-3','TWD','1','-3'),(${ledger},${id},${expense},'3','TWD','1','3')`;
  });
  await db`DELETE FROM transactions WHERE id=${id}`;
  expect(
    await db`SELECT id FROM transaction_entries WHERE transaction_id=${id}`,
  ).toHaveLength(0);
});
it('stores synthetic USD expense and cross-currency transfer with exact known base amounts', async () => {
  const expenseId = await write([
    { item: usd, amount: '-100', currency: 'USD', rate: '32.5', base: '-3250' },
    { item: expense, amount: '3250' },
  ]);
  const transferId = await write(
    [
      {
        item: usd,
        amount: '-100',
        currency: 'USD',
        rate: '32.5',
        base: '-3250',
      },
      { item: cash, amount: '3250' },
    ],
    'transfer',
  );
  for (const id of [expenseId, transferId]) {
    const [r] =
      await db`SELECT sum(base_amount)::text AS sum FROM transaction_entries WHERE transaction_id=${id}`;
    expect(r!.sum).toBe('0.000000');
  }
  const [entry] =
    await db`SELECT amount::text AS amount,exchange_rate::text AS rate,base_amount::text AS base FROM transaction_entries WHERE transaction_id=${expenseId} AND currency='USD'`;
  expect(entry).toEqual({
    amount: '-100.000000',
    rate: '32.5000000000',
    base: '-3250.000000',
  });
});
it.each(['NaN', 'Infinity', '-Infinity', '0'])(
  'rejects non-finite or zero entry amount %s',
  async (amount) => {
    await expect(
      write([
        { item: cash, amount },
        { item: expense, amount: '1' },
      ]),
    ).rejects.toThrow();
  },
);
it('rejects invalid rate and currency mismatches', async () => {
  for (const rate of ['0', '-1', 'NaN', 'Infinity'])
    await expect(
      write([
        { item: cash, amount: '-1', rate },
        { item: expense, amount: '1' },
      ]),
    ).rejects.toThrow();
  await expect(
    write([
      { item: cash, amount: '-1', currency: 'USD' },
      { item: expense, amount: '1' },
    ]),
  ).rejects.toThrow();
});
it('isolates ledger references for entries, payees and parents', async () => {
  const [foreign] =
    await db`INSERT INTO items(ledger_id,kind,name,currency) VALUES (${other},'asset','Cash','TWD') RETURNING id`;
  await expect(
    write([
      { item: String(foreign!.id), amount: '-1' },
      { item: expense, amount: '1' },
    ]),
  ).rejects.toThrow();
  await expect(
    db`UPDATE items SET parent_id=${foreign!.id} WHERE id=${cash}`,
  ).rejects.toThrow();
  const [payee] =
    await db`INSERT INTO payees(ledger_id,name) VALUES (${other},'Foreign synthetic payee') RETURNING id`;
  await expect(
    db.begin(async (sql) => {
      await sql`INSERT INTO transactions(ledger_id,occurred_on,kind,payee_id) VALUES (${ledger},'2026-01-02','expense',${payee!.id})`;
    }),
  ).rejects.toThrow();
});
it('permits identical names across kinds, blocks case-insensitive duplicates and cycles, preserves archived history', async () => {
  const [liability] =
    await db`INSERT INTO items(ledger_id,kind,name,currency) VALUES (${ledger},'liability','Cash','TWD') RETURNING id`;
  expect(liability!.id).toBeTruthy();
  await expect(
    db`INSERT INTO items(ledger_id,kind,name,currency) VALUES (${ledger},'asset','cAsH','TWD')`,
  ).rejects.toThrow();
  const [child] =
    await db`INSERT INTO items(ledger_id,parent_id,kind,name,currency) VALUES (${ledger},${cash},'asset','Child','TWD') RETURNING id`;
  await expect(
    db`UPDATE items SET parent_id=${child!.id} WHERE id=${cash}`,
  ).rejects.toThrow('cycle');
  await expect(
    db`UPDATE items SET parent_id=id WHERE id=${cash}`,
  ).rejects.toThrow();
  await db`UPDATE items SET archived=true WHERE id=${cash}`;
  expect(
    (await db`SELECT id FROM transaction_entries WHERE item_id=${cash}`).length,
  ).toBeGreaterThan(0);
  await db`UPDATE items SET archived=false WHERE id=${cash}`;
});
it('scopes imported source hashes to ledger and allows different hash or validated staging', async () => {
  const hash = 'a'.repeat(64);
  await db`INSERT INTO import_jobs(ledger_id,source_sha256,source_system,status) VALUES (${ledger},${hash},'emoney','imported')`;
  await expect(
    db`INSERT INTO import_jobs(ledger_id,source_sha256,source_system,status) VALUES (${ledger},${hash},'emoney','imported')`,
  ).rejects.toThrow();
  await db`INSERT INTO import_jobs(ledger_id,source_sha256,source_system,status) VALUES (${other},${hash},'emoney','imported'),(${ledger},${'b'.repeat(64)},'emoney','imported'),(${ledger},${hash},'emoney','validated')`;
});
it('serializes concurrent entry edits so opposite imbalances cannot cancel across transactions', async () => {
  const id = await write([
    { item: cash, amount: '-10' },
    { item: expense, amount: '10' },
  ]);
  const results = await Promise.allSettled([
    db.begin(async (sql) => {
      await sql`UPDATE transaction_entries SET base_amount=base_amount+1 WHERE transaction_id=${id} AND item_id=${cash}`;
    }),
    db.begin(async (sql) => {
      await sql`UPDATE transaction_entries SET base_amount=base_amount-1 WHERE transaction_id=${id} AND item_id=${expense}`;
    }),
  ]);
  expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  const [r] =
    await db`SELECT sum(base_amount)::text AS sum FROM transaction_entries WHERE transaction_id=${id}`;
  expect(r!.sum).toBe('0.000000');
});
