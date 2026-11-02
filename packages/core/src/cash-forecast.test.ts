// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { cashForecastSchema } from './cash-forecast-schemas.js';
it('shared REST/MCP forecast parameters are strict and money remains decimal text', () => {
  expect(cashForecastSchema.parse({})).toEqual({
    horizon_days: 30,
    threshold: '0',
  });
  for (const horizon_days of [30, 60, 90, 180, 366])
    expect(
      cashForecastSchema.parse({
        horizon_days: String(horizon_days),
        threshold: '-123456.78',
      }).horizon_days,
    ).toBe(horizon_days);
  for (const input of [
    { horizon_days: 31 },
    { threshold: 0 },
    { threshold: '1e3' },
    { threshold: '1.001' },
    { threshold: 'NaN' },
    { accounts: [] },
    { accounts: 'bad' },
    { date_from: '2026-01-01' },
  ])
    expect(cashForecastSchema.safeParse(input).success).toBe(false);
  const id = '00000000-0000-4000-8000-000000000001';
  expect(cashForecastSchema.parse({ accounts: id }).accounts).toEqual([id]);
  expect(cashForecastSchema.safeParse({ accounts: [id, id] }).success).toBe(
    false,
  );
});
