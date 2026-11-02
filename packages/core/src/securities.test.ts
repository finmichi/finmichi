// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import {
  stockTradeSchema,
  type StockTradeInput,
} from './securities-schemas.js';
import {
  replayStocks,
  stockValues,
  stockUnits,
  stockFixed,
  type ReplayTrade,
} from './securities-math.js';
const oracle = JSON.parse(
  readFileSync(
    new URL('../test/fixtures/securities/oracle.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: {
    name: string;
    input: Record<string, unknown>[];
    expected: Record<string, string>[];
  }[];
  error_cases: {
    name: string;
    input: Record<string, unknown>[];
    error: string;
  }[];
};
function trades(input: Record<string, unknown>[]): ReplayTrade[] {
  return input.map((v, i) => ({
    id: String(i),
    trade_date: '2026-01-01',
    sequence: i + 1,
    ...stockValues(stockTradeSchema.parse({ ...v, trade_date: '2026-01-01' })),
  }));
}
describe('independent Python Decimal oracle (not a CI runtime dependency)', () => {
  for (const c of oracle.cases)
    it(c.name, () => {
      const actual = replayStocks(trades(c.input));
      expect(actual).toHaveLength(c.expected.length);
      c.expected.forEach((e, i) => expect(actual[i]).toMatchObject(e));
    });
  for (const c of oracle.error_cases)
    it(c.name, () => {
      try {
        replayStocks(trades(c.input));
        expect.fail('must reject');
      } catch (e) {
        expect(e).toMatchObject({ code: c.error });
      }
    });
  it('rejects fractional shares and fee/tax precision before money conversion', () => {
    const v = {
      trade_type: 'buy',
      trade_date: '2026-01-01',
      quantity: '1',
      price: '1.005',
      fee: '0',
      tax: '0',
    };
    expect(stockTradeSchema.safeParse(v).success).toBe(true);
    for (const field of ['fee', 'tax'])
      expect(
        stockTradeSchema.safeParse({ ...v, [field]: '0.001' }).success,
      ).toBe(false);
    expect(stockTradeSchema.safeParse({ ...v, quantity: '1.5' }).success).toBe(
      false,
    );
  });
  it('orders dates then explicit same-day sequence', () => {
    const rows = trades([
      { trade_type: 'buy', quantity: '100', price: '10' },
      { trade_type: 'buy', quantity: '100', price: '30' },
      { trade_type: 'sell', quantity: '100', price: '20' },
    ]);
    expect(
      replayStocks([rows[2]!, rows[0]!, rows[1]!]).at(-1)?.cost_removed,
    ).toBe('2000.00');
    rows[1]!.sequence = 4;
    expect(
      replayStocks(rows).find((s) => s.trade_id === '2')?.cost_removed,
    ).toBe('1000.00');
  });
  it('preserves all invested cents after arbitrary partial sales and a final liquidation', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            q: fc.bigInt({ min: 1n, max: 10000n }),
            p: fc.bigInt({ min: 1n, max: 1000000n }),
            fee: fc.bigInt({ min: 0n, max: 1000n }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        fc.bigInt({ min: 1n, max: 999n }),
        (buys, part) => {
          let q = 0n;
          const input: StockTradeInput[] = buys.map((b) => {
            q += b.q;
            return stockTradeSchema.parse({
              trade_type: 'buy',
              trade_date: '2026-01-01',
              quantity: b.q.toString(),
              price: stockFixed(b.p),
              fee: stockFixed(b.fee),
            });
          });
          const sold = (q * part) / 1000n;
          if (sold)
            input.push(
              stockTradeSchema.parse({
                trade_type: 'sell',
                trade_date: '2026-01-01',
                quantity: sold.toString(),
                price: '10',
              }),
            );
          input.push(
            stockTradeSchema.parse({
              trade_type: 'sell',
              trade_date: '2026-01-01',
              quantity: (q - sold).toString(),
              price: '10',
            }),
          );
          const result = replayStocks(
            input.map((v, i) => ({
              id: String(i),
              trade_date: v.trade_date,
              sequence: i + 1,
              ...stockValues(v),
            })),
          );
          const invested = buys.reduce((s, b) => s + b.q * b.p + b.fee, 0n);
          expect(
            result
              .filter((_, i) => i >= buys.length)
              .reduce((s, r) => s + stockUnits(r.cost_removed), 0n),
          ).toBe(invested);
          expect(result.at(-1)).toMatchObject({
            quantity_after: '0',
            cost_after: '0.00',
          });
          for (const r of result) {
            expect(stockUnits(r.cost_after) >= 0n).toBe(true);
            expect(BigInt(r.quantity_after) >= 0n).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
it('partial security metadata does not implicitly unarchive a record', async () => {
  const { securityUpdateSchema } = await import('./securities-schemas.js');
  expect(securityUpdateSchema.parse({ name: '合成重新命名' })).toEqual({
    name: '合成重新命名',
  });
});
it('history rejects a decoded impossible cursor date before issuing SQL', async () => {
  const { securityReports } = await import('./securities-read.js');
  const fake = {} as import('@finmichi/db').Database;
  const id = '00000000-0000-4000-8000-000000000001';
  const cursor = Buffer.from(
    JSON.stringify({ date: '2026-02-30', sequence: 1, security: id }),
  ).toString('base64url');
  await expect(
    securityReports(fake).history(id, id, id, { cursor }),
  ).rejects.toMatchObject({ code: 'invalid_input', statusCode: 400 });
});
it('valuation accepts an aggregate quantity above individual-trade precision without Number conversion', async () => {
  const { valueHoldings } = await import('./market-math.js');
  expect(
    valueHoldings(
      [{ market: 'TWSE', symbol: '9999A', quantity: '1000000000000000000' }],
      [
        {
          market: 'TWSE',
          symbol: '9999A',
          trade_date: '2026-01-01',
          close: '2.5',
          source: 'twse',
        },
      ],
      '2026-01-01',
    )[0]!.market_amount,
  ).toBe('2500000000000000000.00');
});

it('holding origin follows the current position including the final zero, resetting only on the next trade', async () => {
  const { holdingOrigin } = await import('./securities-math.js');
  const rows = [
    {
      origin: 'emoney' as const,
      position_quantity: '100',
      trade_date: '2026-01-01',
      sequence: 1,
    },
    {
      origin: 'app' as const,
      position_quantity: '110',
      trade_date: '2026-01-02',
      sequence: 1,
    },
    {
      origin: 'emoney' as const,
      position_quantity: '0',
      trade_date: '2026-01-03',
      sequence: 1,
    },
    {
      origin: 'app' as const,
      position_quantity: '10',
      trade_date: '2026-01-04',
      sequence: 1,
    },
  ];
  expect(holdingOrigin(rows.slice(0, 1))).toBe('emoney');
  expect(holdingOrigin(rows.slice(0, 2))).toBe('mixed');
  expect(holdingOrigin(rows.slice(0, 3))).toBe('mixed');
  expect(holdingOrigin(rows)).toBe('app');
});
