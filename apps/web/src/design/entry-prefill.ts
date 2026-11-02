// SPDX-License-Identifier: AGPL-3.0-only
import type { TransactionInput } from '@finmichi/core/transaction-schemas';
export interface PaymentPrefill {
  ledgerId: string;
  input: TransactionInput;
  mode: 'advanced' | 'transfer';
  notice?: string | undefined;
}
let pending: PaymentPrefill | null = null;
export function queuePaymentPrefill(
  ledgerId: string,
  input: TransactionInput,
  mode: PaymentPrefill['mode'] = 'advanced',
  notice?: string,
) {
  pending = { ledgerId, input, mode, notice };
}
// React may restart an uncommitted render. Reading must never consume its payload.
export function readPaymentPrefill(ledgerId: string) {
  return pending?.ledgerId === ledgerId ? pending : null;
}
// Acknowledge only after commit, and do not discard a newer payment request.
export function acknowledgePaymentPrefill(snapshot: PaymentPrefill | null) {
  if (pending === snapshot) pending = null;
}
