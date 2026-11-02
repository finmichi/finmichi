// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { draftLimitSchema, draftCreateSchema } from './draft-schemas.js';
it('draft base amount limit is a decimal string bounded exactly at 0.01 and 10000000', () => {
  for (const s of ['0.01', '100000', '10000000.00'])
    expect(draftLimitSchema.parse(s)).toBe(s);
  for (const s of [
    '0',
    '-0.01',
    '10000000.01',
    '1e5',
    'NaN',
    'Infinity',
    '0.001',
    'foo',
    '01',
    '',
  ])
    expect(draftLimitSchema.safeParse(s).success).toBe(false);
  expect(draftLimitSchema.safeParse(100000).success).toBe(false);
});
it('draft notes and transaction payload stay strict and cannot request posting', () => {
  expect(
    draftCreateSchema.safeParse({
      ledger_id: '00000000-0000-4000-8000-000000000001',
      occurred_on: '2026-10-21',
      entries: [],
      auto_post: true,
    }).success,
  ).toBe(false);
});
