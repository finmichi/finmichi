// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { nextOccurrence, frequencyPreview } from './recurring-calendar.js';
import { recurringRuleSchema } from './recurring-schemas.js';
import { afterWorkerTime, workerRetryDelay } from './recurring-worker.js';
const monthly = {
  frequency: 'monthly' as const,
  interval: 1,
  day_of_month: 31,
  weekday: null,
  month: null,
  day: null,
  start_on: '2024-01-01',
};
it('31st clamps independently in February / April and recovers the original 31st', () => {
  let d = nextOccurrence(monthly);
  const dates = [];
  for (let i = 0; i < 5; i++) {
    dates.push(d);
    d = nextOccurrence(monthly, d!);
  }
  expect(dates).toEqual([
    '2024-01-31',
    '2024-02-29',
    '2024-03-31',
    '2024-04-30',
    '2024-05-31',
  ]);
  expect(nextOccurrence({ ...monthly, start_on: '2025-02-01' })).toBe(
    '2025-02-28',
  );
});
it('every two months anchors to the start month, not the clamped previous day', () => {
  const r = { ...monthly, interval: 2 };
  let d = nextOccurrence(r);
  expect(d).toBe('2024-01-31');
  d = nextOccurrence(r, d!);
  expect(d).toBe('2024-03-31');
  expect(nextOccurrence(r, d!)).toBe('2024-05-31');
  expect(
    nextOccurrence({ ...r, start_on: '2024-01-31', day_of_month: 1 }),
  ).toBe('2024-03-01');
});
it('weekly starts on/after start_on with interval weeks', () => {
  const r = {
    ...monthly,
    frequency: 'weekly' as const,
    weekday: 0,
    start_on: '2026-01-01',
    interval: 2,
  };
  const first = nextOccurrence(r);
  expect(first).toBe('2026-01-04');
  expect(nextOccurrence(r, first!)).toBe('2026-01-18');
});
it('yearly Feb29 clamps in common years and recovers in leap years', () => {
  const r = {
    ...monthly,
    frequency: 'yearly' as const,
    month: 2,
    day: 29,
    start_on: '2023-01-01',
  };
  let d = nextOccurrence(r);
  expect(d).toBe('2023-02-28');
  d = nextOccurrence(r, d!);
  expect(d).toBe('2024-02-29');
  expect(nextOccurrence(r, d!)).toBe('2025-02-28');
  expect(nextOccurrence({ ...r, interval: 2, start_on: '2024-03-01' })).toBe(
    '2026-02-28',
  );
});
it('handles year rollover and finite ISO date boundary without 1900 offset', () => {
  expect(nextOccurrence({ ...monthly, start_on: '0001-01-01' })).toBe(
    '0001-01-31',
  );
  expect(nextOccurrence(monthly, '2024-12-31')).toBe('2025-01-31');
  expect(nextOccurrence(monthly, '9999-12-31')).toBeNull();
  expect(frequencyPreview({ ...monthly, interval: 2 })).toContain(
    '每 2 個月的 31 日',
  );
});
it('worker begins at exactly Taipei 06:00; host timezone is irrelevant', () => {
  expect(afterWorkerTime(new Date('2026-01-01T21:59:59Z'))).toBe(false);
  expect(afterWorkerTime(new Date('2026-01-01T22:00:00Z'))).toBe(true);
  expect(afterWorkerTime(new Date('2026-01-02T16:00:00Z'))).toBe(false);
});
it('rejects contradictory schedule fields, invalid yearly day, non-string money and unknown fields', () => {
  const template = {
    entries: [
      { item_id: '00000000-0000-4000-8000-000000000001', amount: '-1' },
      { item_id: '00000000-0000-4000-8000-000000000002', amount: '1' },
    ],
  };
  const r = { ...monthly, name: 'Synthetic', template };
  expect(recurringRuleSchema.safeParse(r).success).toBe(true);
  for (const extra of [
    { interval: 0 },
    { interval: 13 },
    { weekday: 0 },
    { end_on: '2023-01-01' },
    { frequency: 'yearly', day_of_month: null, month: 4, day: 31 },
    { unknown: true },
    {
      template: {
        entries: [{ ...template.entries[0], amount: 1 }, template.entries[1]],
      },
    },
  ])
    expect(recurringRuleSchema.safeParse({ ...r, ...extra }).success).toBe(
      false,
    );
});

it('worker exponential retry is capped and can reset after success for both per-ledger and transport failures', () => {
  expect([1, 2, 3, 7, 20, 1000].map((n) => workerRetryDelay(n))).toEqual([
    300000, 600000, 1200000, 19200000, 21600000, 21600000,
  ]);
  expect(workerRetryDelay(1)).toBe(300000);
  expect([1, 2, 20].map((n) => workerRetryDelay(n, 30000, 1800000))).toEqual([
    30000, 60000, 1800000,
  ]);
});
