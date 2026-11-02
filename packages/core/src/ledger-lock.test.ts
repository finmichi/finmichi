// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { ledgerLockSchema, lockChange, taipeiToday } from './ledger-lock.js';
const now = new Date('2026-10-17T16:00:00Z');
it('uses Asia/Taipei today at midnight, not host UTC', () => {
  expect(taipeiToday(new Date('2026-10-17T15:59:59Z'))).toBe('2026-10-17');
  expect(taipeiToday(now)).toBe('2026-10-18');
  expect(taipeiToday(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01');
  expect(lockChange(null, '2026-10-18', false, now)).toBe('ledger.lock');
  expect(() => lockChange(null, '2026-10-19', true, now)).toThrow(
    'invalid_input',
  );
});
it('permits advancing / unchanged lock; requires literal confirmation for earlier date or clearing', () => {
  expect(lockChange('2026-09-30', '2026-10-17', undefined, now)).toBe(
    'ledger.lock',
  );
  expect(lockChange('2026-09-30', '2026-09-30', false, now)).toBe(
    'ledger.lock',
  );
  for (const next of ['2026-09-29', null]) {
    for (const flag of [undefined, false])
      expect(() => lockChange('2026-09-30', next, flag, now)).toThrow(
        'unlock_confirmation_required',
      );
    expect(lockChange('2026-09-30', next, true, now)).toBe('ledger.unlock');
  }
  expect(lockChange(null, null, undefined, now)).toBe('ledger.unlock');
});
it('strictly validates real date / null and boolean confirmation, never coerces strings', () => {
  for (const input of [
    {},
    { locked_until: '' },
    { locked_until: '2026-02-30' },
    { locked_until: '0000-01-01' },
    { locked_until: '2026-1-01' },
    { locked_until: null, confirm_unlock: 'true' },
    { locked_until: null, owner_id: 'ignored' },
  ])
    expect(ledgerLockSchema.safeParse(input).success).toBe(false);
  expect(
    ledgerLockSchema.parse({
      locked_until: '2024-02-29',
      confirm_unlock: true,
    }),
  ).toEqual({ locked_until: '2024-02-29', confirm_unlock: true });
});
