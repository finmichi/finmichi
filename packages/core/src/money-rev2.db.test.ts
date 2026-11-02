// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, expect, it } from 'vitest';
import { connect, migrate } from '@finmichi/db';
import {
  calculateBaseAmounts as calc,
  calculateImportBaseAmounts as imp,
  roundHalfUp,
  moneyUnits,
  type CalculatedEntry,
  type MoneyEntry,
} from './money.js';
if (!process.env.TEST_DATABASE_URL)
  throw new Error('TEST_DATABASE_URL required');
const db = connect(process.env.TEST_DATABASE_URL);
let ledger: string;
const items = new Map<string, string>();
beforeAll(async () => {
  await migrate(db);
  const [u] =
    await db`INSERT INTO users(oidc_issuer,oidc_subject) VALUES ('https://money.synthetic.invalid','money-rev2') RETURNING id`;
  const [l] =
    await db`INSERT INTO ledgers(owner_id,name) VALUES (${u!.id},'Synthetic rounding') RETURNING id`;
  ledger = String(l!.id);
  for (const currency of ['TWD', 'USD', 'JPY']) {
    const [item] =
      await db`INSERT INTO items(ledger_id,kind,name,currency) VALUES (${ledger},'asset',${'Synthetic ' + currency},${currency}) RETURNING id`;
    items.set(currency, String(item!.id));
  }
});
afterAll(async () => {
  await db.end();
});
const fx = (
  amount: string,
  currency = 'USD',
  exchangeRate = '1',
): MoneyEntry => ({ amount, currency, exchangeRate });
const twd = (amount: string) => fx(amount, 'TWD');
async function persist(entries: CalculatedEntry[], kind = 'transfer') {
  return db.begin(async (sql) => {
    const [tx] =
      await sql`INSERT INTO transactions(ledger_id,occurred_on,kind) VALUES (${ledger},'2026-10-16',${kind}) RETURNING id`;
    for (const e of entries) {
      let itemId = items.get(e.currency)!;
      if (e.systemItem) {
        const [system] =
          await sql`INSERT INTO items(ledger_id,kind,name,currency,non_operating) VALUES (${ledger},'income',${e.systemItem.name},'TWD',true) ON CONFLICT (ledger_id,kind,lower(name)) DO UPDATE SET name=EXCLUDED.name RETURNING id`;
        itemId = String(system!.id);
      }
      await sql`INSERT INTO transaction_entries(ledger_id,transaction_id,item_id,amount,currency,exchange_rate,base_amount) VALUES (${ledger},${tx!.id},${itemId},${e.amount},${e.currency},${e.exchangeRate},${e.baseAmount})`;
    }
    return String(tx!.id);
  });
}
const cases: { name: string; entries: MoneyEntry[]; bases: string[] }[] = [
  {
    name: 'A income',
    entries: [twd('-100'), twd('100')],
    bases: ['-100.00', '100.00'],
  },
  {
    name: 'A expense',
    entries: [twd('-0.01'), twd('0.01')],
    bases: ['-0.01', '0.01'],
  },
  {
    name: 'A transfer',
    entries: [twd('-123.45'), twd('123.45')],
    bases: ['-123.45', '123.45'],
  },
  {
    name: 'USD33.33 at32.567',
    entries: [fx('-33.33', 'USD', '32.567'), fx('33.33', 'USD', '32.567')],
    bases: ['-1085.46', '1085.46'],
  },
  {
    name: 'three legs skip zero candidates',
    entries: [fx('0.005'), fx('0.005'), fx('-0.010')],
    bases: ['0.01', '0.01', '-0.02'],
  },
  {
    name: 'six legs each +0.01',
    entries: [...Array.from({ length: 6 }, () => fx('1.004')), twd('-6.06')],
    bases: ['1.01', '1.01', '1.01', '1.01', '1.01', '1.01', '-6.06'],
  },
  {
    name: 'actual USD100 at32.51',
    entries: [fx('-100', 'USD', '32.5'), twd('3251')],
    bases: ['-3251.00', '3251.00'],
  },
  {
    name: 'large C amount',
    entries: [fx('-99999999.999999', 'USD', '32.5'), twd('3251000000.01')],
    bases: ['-3251000000.01', '3251000000.01'],
  },
  {
    name: 'USD/JPY plus TWD fee',
    entries: [fx('-1', 'USD', '32.5'), fx('160', 'JPY', '0.2'), twd('0.51')],
    bases: ['-32.51', '32.00', '0.51'],
  },
];
it.each(cases)('service to DB: $name', async (c) => {
  const result = calc(c.entries);
  expect(result.entries.map((e) => e.baseAmount)).toEqual(c.bases);
  const id = await persist(result.entries);
  const [sum] =
    await db`SELECT sum(base_amount)::text AS total FROM transaction_entries WHERE transaction_id=${id}`;
  expect(sum!.total).toBe('0.000000');
  const rows =
    await db`SELECT amount::text,base_amount::text,exchange_rate::text FROM transaction_entries WHERE transaction_id=${id}`;
  expect(rows).toHaveLength(c.entries.length);
  for (const e of result.entries)
    expect(
      rows.some(
        (r) =>
          moneyUnits(String(r.amount)) === moneyUnits(e.amount) &&
          moneyUnits(String(r.base_amount)) === moneyUnits(e.baseAmount) &&
          String(r.exchange_rate) === e.exchangeRate,
      ),
    ).toBe(true);
});
it.each([
  '0.005',
  '-0.005',
  '1.005',
  '-1.005',
  '2.675',
  '-2.675',
  '0.0049',
  '-0.0049',
])('BigInt HALF_UP matches PostgreSQL round(%s,2)', async (value) => {
  const [r] = await db`SELECT round(${value}::numeric,2)::text AS rounded`;
  expect(roundHalfUp(value)).toBe(r!.rounded);
});
it('DB independently rejects base precision, zero and mismatched signs', async () => {
  const pair = calc([fx('-1'), fx('1')]).entries;
  await expect(
    persist(
      pair.map((e) => ({
        ...e,
        amount: e.amount === '-1' ? '-1.001' : '1.001',
        baseAmount: e.amount === '-1' ? '-1.001' : '1.001',
      })),
    ),
  ).rejects.toThrow('entries_base_two_decimals');
  await expect(
    persist(
      pair.map((e) => ({
        ...e,
        baseAmount: e.amount === '-1' ? '1.00' : '-1.00',
      })),
    ),
  ).rejects.toThrow('entries_base_same_sign');
  await expect(
    persist(pair.map((e) => ({ ...e, baseAmount: '0.00' }))),
  ).rejects.toThrow('entries_base_same_sign');
});
it('DB independently rejects base currency rate !=1 or base !=amount', async () => {
  const pair = calc([twd('-1'), twd('1')]).entries;
  await expect(
    persist(pair.map((e) => ({ ...e, exchangeRate: '2' }))),
  ).rejects.toThrow('ADR-0002');
  await expect(
    persist(
      pair.map((e) => ({
        ...e,
        baseAmount: e.amount === '-1' ? '-1.01' : '1.01',
      })),
    ),
  ).rejects.toThrow('ADR-0002');
});
it('DB enforces rev.2 deviation formula, allowing 0.02 and rejecting0.03', async () => {
  const pair = calc([fx('-1'), fx('1')]).entries;
  await persist(
    pair.map((e) => ({
      ...e,
      baseAmount: e.amount === '-1' ? '-1.02' : '1.02',
    })),
  );
  await expect(
    persist(
      pair.map((e) => ({
        ...e,
        baseAmount: e.amount === '-1' ? '-1.03' : '1.03',
      })),
    ),
  ).rejects.toThrow('ADR-0002');
});
it('base currency changes cannot invalidate existing entries', async () => {
  await expect(
    db`UPDATE ledgers SET base_currency='USD' WHERE id=${ledger}`,
  ).rejects.toThrow('ADR-0002');
  const [r] = await db`SELECT base_currency FROM ledgers WHERE id=${ledger}`;
  expect(r!.base_currency).toBe('TWD');
});
it('import residual0.37 plan persists exact zero and non-operating income, preserving original amounts', async () => {
  const plan = imp([fx('1'), fx('-0.63', 'JPY')]);
  expect(plan.entries[2]!.systemItem?.sourceReason).toBe(
    'fx_rounding_residual',
  );
  const id = await persist(plan.entries);
  const [sum] =
    await db`SELECT sum(e.base_amount)::text AS sum FROM transaction_entries e WHERE transaction_id=${id}`;
  expect(sum!.sum).toBe('0.000000');
  const [tail] =
    await db`SELECT e.amount::text AS amount,i.kind,i.non_operating FROM transaction_entries e JOIN items i ON i.id=e.item_id WHERE transaction_id=${id} AND i.name='匯兌尾差'`;
  expect(tail).toEqual({
    amount: '-0.370000',
    kind: 'income',
    non_operating: true,
  });
  expect(() => imp([fx('2.01'), fx('-1', 'JPY')])).toThrow('unbalanced');
});
