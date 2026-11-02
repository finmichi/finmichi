// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { profitLossSchema, accountLedgerSchema } from './report-schemas.js';
it('profit-loss strict contract excludes fixed and day grain', () => {
  const q = { date_from: '2026-01-01', date_to: '2026-12-31', grain: 'month' };
  expect(profitLossSchema.safeParse(q).success).toBe(true);
  expect(
    profitLossSchema.safeParse({ ...q, date_from: '0000-01-01' }).success,
  ).toBe(false);
  for (const fixed of ['all', 'fixed', 'variable'])
    expect(profitLossSchema.safeParse({ ...q, fixed }).success).toBe(false);
  expect(profitLossSchema.safeParse({ ...q, grain: 'day' }).success).toBe(
    false,
  );
});
it('ten-year end is exclusive and clamps leap day exactly like PostgreSQL interval arithmetic', () => {
  for (const [date_from, date_to, pass] of [
    ['2020-01-01', '2029-12-31', true],
    ['2020-01-01', '2030-01-01', false],
    ['2020-02-29', '2030-02-27', true],
    ['2020-02-29', '2030-02-28', false],
    ['9995-01-01', '9999-12-31', true],
  ] as const)
    expect(
      profitLossSchema.safeParse({ date_from, date_to, grain: 'month' })
        .success,
    ).toBe(pass);
});
it('account-ledger page size defaults100, allows500 and rejects >500 or fractional values', () => {
  const q = {
    item_id: '00000000-0000-4000-8000-000000000001',
    date_from: '2026-01-01',
    date_to: '2026-12-31',
  };
  expect(accountLedgerSchema.parse(q).limit).toBe(100);
  expect(accountLedgerSchema.parse({ ...q, limit: '500' }).limit).toBe(500);
  for (const limit of [0, 501, '1.5', 'NaN'])
    expect(accountLedgerSchema.safeParse({ ...q, limit }).success).toBe(false);
});
