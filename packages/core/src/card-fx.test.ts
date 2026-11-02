// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { cardQuote, cardConvertedAmount, cardAllocations } from './card-fx.js';
import type { FxRate } from './market-schemas.js';
import type { CardsResult } from './finance.js';
const row = (
  currency: string,
  rate_date: string,
  buy: string | null,
  sell: string | null,
): FxRate => ({
  currency,
  rate_date,
  source: 'bot',
  spot_buy: buy,
  spot_sell: sell,
  cash_buy: null,
  cash_sell: null,
});
it('spot sell precedes ledger; exact four-place half-up, cross uses common date and denominator buy', () => {
  const rows = [
    row('USD', '2026-10-01', '32', '32.12345'),
    row('EUR', '2026-10-01', '40', '41'),
    row('USD', '2026-10-02', '33', '34'),
  ];
  const ledger = [
    {
      from_currency: 'USD',
      to_currency: 'TWD',
      rate: '31',
      rate_date: '2026-10-02',
    },
  ];
  expect(cardQuote(rows, ledger, 'USD', 'TWD', '2026-10-01')).toEqual({
    rate: '32.1235',
    rate_date: '2026-10-01',
    source: 'bot',
  });
  expect(cardConvertedAmount('100.01', '32.1235')).toBe('3212.67');
  expect(cardQuote(rows, [], 'EUR', 'USD', '2026-10-02')).toEqual({
    rate: '1.2813',
    rate_date: '2026-10-01',
    source: 'bot-cross',
  }); // 41 / 32 = 1.28125
  expect(cardQuote(rows, [], 'TWD', 'USD', '2026-10-01')?.rate).toBe('0.0313');
  expect(cardQuote([], ledger, 'USD', 'TWD', '2026-10-02')?.source).toBe(
    'ledger',
  );
  expect(cardQuote([], ledger, 'USD', 'TWD', '2026-10-01')).toBeNull();
  expect(
    cardQuote(
      [row('USD', '2026-10-01', '32', null)],
      [],
      'USD',
      'TWD',
      '2026-10-01',
    ),
  ).toBeNull();
  expect(
    cardQuote(
      [
        row('USD', '2026-10-02', '32', '33'),
        row('EUR', '2026-10-01', '40', '41'),
      ],
      [],
      'EUR',
      'USD',
      '2026-10-02',
    ),
  ).toBeNull();
});
it('allocations cap original outstanding before conversion; late-paid zero debt never projects old bills', () => {
  const c = {
    current_balance: '100.000000',
    statement_day: 5,
    due_day: 20,
    due_month_offset: 1,
    next_close: '2026-11-05',
    bills: [
      { to: '2026-10-05', due_on: '2026-11-20', unpaid: '100' },
      { to: '2026-09-05', due_on: '2026-10-20', unpaid: '100' },
    ],
  } as CardsResult['cards'][number];
  expect(cardAllocations(c)).toEqual([
    {
      statement_on: '2026-09-05',
      due_on: '2026-10-20',
      amount: '100.000000',
      unclosed: false,
    },
  ]);
  expect(cardAllocations({ ...c, current_balance: '0' })).toEqual([]);
  expect(
    cardAllocations({ ...c, current_balance: '150' }).map((r) => r.amount),
  ).toEqual(['100.000000', '50.000000']);
});
