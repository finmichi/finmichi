// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readBundle } from './bundle.js';
import {
  investmentMappingSchema,
  transformInvestments,
  roundedPrice,
  type InvestmentContext,
} from './investment-transform.js';
async function setup() {
  const bundle = await readBundle(
    fileURLToPath(new URL('../fixtures-investments', import.meta.url)),
  );
  const mapping = investmentMappingSchema.parse(
    JSON.parse(
      await readFile(
        fileURLToPath(
          new URL('../investments.mapping.example.json', import.meta.url),
        ),
        'utf8',
      ),
    ),
  );
  const ctx: InvestmentContext = {
    today: '2026-10-23',
    items: [
      ['現金', 'asset'],
      ['銀行', 'asset'],
      ['薪資', 'income'],
    ].map(([name, kind]) => ({
      id: randomUUID(),
      name: name!,
      kind: kind!,
      currency: 'TWD',
      securities: false,
      non_operating: false,
      credit_card: false,
      loan: false,
      archived: false,
    })),
    markets: [],
    transactions: [{ id: randomUUID(), source_id: 'expense' }],
  };
  return { bundle, mapping, ctx };
}
it('synthetic CSV: slash dates, HALF_UP 4, ETF symbols, zero price dividend, missing/irregular journal links and monthly deposits', async () => {
  const { bundle, mapping, ctx } = await setup(),
    p = transformInvestments(bundle, mapping, ctx);
  expect(p.securities.map((s) => s.symbol)).toEqual(['00999', '0099B']);
  expect(
    p.trades.map((t) => [
      t.trade_type,
      t.price,
      t.position_quantity,
      t.position_cost,
      t.realized_gain,
    ]),
  ).toEqual([
    ['buy', '10.0000', '100', '1001.00', '0.00'],
    ['stock_dividend', '0.0000', '110', '1001.00', '0.00'],
    ['sell', '20.0000', '100', '910.00', '107.00'],
    ['buy', '5.0000', '20', '100.00', '0.00'],
  ]);
  expect(p.trades[0]!.source_transaction_id).toBe(ctx.transactions[0]!.id);
  expect(p.trades[1]!.source_transaction_id).toBeNull();
  expect(
    p.trades.every((t) => t.origin === 'emoney' && t.transaction_id === null),
  ).toBe(true);
  expect(p.deposits.map((d) => d.status)).toEqual(['active', 'matured']);
  expect(p.deposits[0]).toMatchObject({
    interest_basis: 'monthly',
    auto_renew: true,
    payout: 'at_maturity',
  });
  expect(p.deposits[0]!.note).toContain('機動利率');
  expect(p.warnings.map((w) => w.code)).toEqual(
    expect.arrayContaining([
      'stock_price_rounded',
      'deposit_period_mismatch',
      'deposit_already_matured',
    ]),
  );
  expect(p.created_items.filter((i) => i.name === '合成定存')).toHaveLength(1);
});
it.each([
  ['INOUT_DATE', '2026/02/30', 'stock_date_invalid'],
  ['IN_QUANTY', '0.1', 'stock_quantity_invalid'],
  ['OUT_QUANTY', '1', 'stock_quantity_invalid'],
  ['FINANCE_MOUNT', '1', 'margin_not_supported'],
  ['STOCK_CLASS', '融資買進', 'stock_class_unsupported'],
  ['STOCK_ID', 'bad', 'invalid_security_symbol'],
])('rejects %s invalid synthetic row', async (field, value, code) => {
  const { bundle, mapping, ctx } = await setup();
  bundle.tables.get('STOCK_DATA')![0]![field] = value;
  expect(() => transformInvestments(bundle, mapping, ctx)).toThrow(code);
});
it('duplicate keys, unknown market, negative historical holdings, amount mismatch', async () => {
  const { bundle, mapping, ctx } = await setup();
  const row = bundle.tables.get('STOCK_DATA')![0]!;
  bundle.tables.get('STOCK_DATA')!.push({ ...row });
  expect(() => transformInvestments(bundle, mapping, ctx)).toThrow(
    'duplicate_source_key',
  );
  bundle.tables.get('STOCK_DATA')!.pop();
  const markets = mapping.security_markets;
  mapping.security_markets = {};
  expect(() => transformInvestments(bundle, mapping, ctx)).toThrow(
    'security_market_unknown',
  );
  mapping.security_markets = markets;
  row.INOUT_MOUNT = '1002';
  expect(transformInvestments(bundle, mapping, ctx).warnings).toContainEqual({
    code: 'stock_amount_mismatch',
    key: 'STOCK_DATA:1:1',
    difference: '1.00',
  });
  bundle.tables.get('STOCK_DATA')![2]!.OUT_QUANTY = '111';
  expect(() => transformInvestments(bundle, mapping, ctx)).toThrow(
    'insufficient_shares',
  );
});
it('deposit mapping 0/1/multiple; currency mismatch; rates never rounded; daily fallback', async () => {
  const { bundle, mapping, ctx } = await setup(),
    rule = mapping.deposit_items[0]!;
  mapping.deposit_items = [];
  expect(() => transformInvestments(bundle, mapping, ctx)).toThrow(
    'deposit_item_unmapped',
  );
  mapping.deposit_items = [rule, { ...rule, prefix: '合成人-' }];
  expect(() => transformInvestments(bundle, mapping, ctx)).toThrow(
    'deposit_item_ambiguous',
  );
  mapping.deposit_items = [rule];
  bundle.tables.get('REGULAR_DATA')![0]!.CURRENCY_NOTE = '美元';
  expect(() => transformInvestments(bundle, mapping, ctx)).toThrow(
    'deposit_currency_mismatch',
  );
  bundle.tables.get('REGULAR_DATA')![0]!.CURRENCY_NOTE = '台幣';
  bundle.tables.get('REGULAR_DATA')![0]!.PROFIT_RATIO = '1.7000001';
  expect(() => transformInvestments(bundle, mapping, ctx)).toThrow(
    'invalid_amount',
  );
  bundle.tables.get('REGULAR_DATA')![0]!.PROFIT_RATIO = '1.7';
  bundle.tables.get('REGULAR_DATA')![0]!.END_DATE = '2027/01/02';
  expect(
    transformInvestments(bundle, mapping, ctx).deposits[0]!.interest_basis,
  ).toBe('daily');
});
it('price rounding is decimal, not binary floating point', () => {
  expect(roundedPrice('1.23445')).toEqual({ price: '1.2345', rounded: true });
  expect(roundedPrice('14.10000000000001')).toEqual({
    price: '14.1000',
    rounded: true,
  });
  expect(roundedPrice('14.10000000000000').rounded).toBe(false);
});
it.each([
  ['1.700000', '1.7'],
  ['0.000000', '0'],
  ['10.000000', '10'],
  ['1.000001', '1.000001'],
])(
  'deposit note trims rate %s without changing stored precision',
  async (raw, display) => {
    const { bundle, mapping, ctx } = await setup();
    const row = bundle.tables.get('REGULAR_DATA')![0]!;
    row.PROFIT_TYPE = '機動';
    row.PROFIT_RATIO = raw;
    const p = transformInvestments(bundle, mapping, ctx);
    expect(p.deposits[0]!.annual_rate).toBe(raw);
    expect(p.deposits[0]!.note).toContain(`轉入時 ${display}%`);
  },
);
