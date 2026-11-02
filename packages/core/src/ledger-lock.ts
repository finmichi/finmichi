// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { DomainError } from './catalog.js';

export const ledgerLockSchema = z.strictObject({
  locked_until: z.iso
    .date()
    .refine((d) => !d.startsWith('0000'))
    .nullable(),
  confirm_unlock: z.boolean().optional(),
});
// Use the business timezone even when the host / CI runs in UTC.
export function taipeiToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function lockChange(
  old: string | null,
  next: string | null,
  confirm: boolean | undefined,
  now = new Date(),
) {
  if (next !== null && next > taipeiToday(now))
    throw new DomainError('invalid_input', 400);
  const unlocking = old !== null && (next === null || next < old);
  if (unlocking && confirm !== true)
    throw new DomainError('unlock_confirmation_required', 409);
  return unlocking || next === null
    ? ('ledger.unlock' as const)
    : ('ledger.lock' as const);
}
