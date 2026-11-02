// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import { reminderFingerprint } from './reminders.js';
import {
  reminderSettingsSchema,
  reminderReadSchema,
} from './reminder-schemas.js';
it('canonical fingerprints ignore object order but change with payload amounts and dates', () => {
  expect(reminderFingerprint({ a: '1', b: { z: 2, y: 1 } })).toBe(
    reminderFingerprint({ b: { y: 1, z: 2 }, a: '1' }),
  );
  expect(reminderFingerprint({ amount: '1' })).not.toBe(
    reminderFingerprint({ amount: '2' }),
  );
  expect(reminderFingerprint({ date: '2026-01-01' })).not.toBe(
    reminderFingerprint({ date: '2026-01-02' }),
  );
});
it('settings enforce inclusive limits and strict read marking shapes', () => {
  expect(reminderSettingsSchema.parse({})).toMatchObject({
    deposit_days: 7,
    card_days: 7,
    loan_days: 3,
    recurring_days: 0,
    draft_days: 0,
    market_trading_days: 3,
  });
  for (const field of [
    'deposit_days',
    'card_days',
    'loan_days',
    'recurring_days',
    'draft_days',
  ]) {
    for (const value of [0, 60])
      expect(reminderSettingsSchema.safeParse({ [field]: value }).success).toBe(
        true,
      );
    for (const value of [-1, 61, 1.5, '2'])
      expect(reminderSettingsSchema.safeParse({ [field]: value }).success).toBe(
        false,
      );
  }
  for (const value of [0, 21])
    expect(
      reminderSettingsSchema.safeParse({ market_trading_days: value }).success,
    ).toBe(false);
  expect(reminderReadSchema.safeParse({ all: true, items: [] }).success).toBe(
    false,
  );
  expect(reminderReadSchema.safeParse({ items: [] }).success).toBe(false);
  expect(reminderReadSchema.safeParse({ all: true }).success).toBe(true);
});
