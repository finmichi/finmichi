// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect } from 'vitest';
import {
  queuePaymentPrefill,
  readPaymentPrefill,
  acknowledgePaymentPrefill,
} from './entry-prefill';
const input = {
  occurred_on: '2026-10-19',
  memo: '',
  payee_id: null,
  project_id: null,
  invoice_no: '',
  entries: [
    { item_id: 'asset', amount: '-0.06' },
    { item_id: 'loan', amount: '0.06' },
  ],
};
it('repeated uncommitted render reads retain exactly the same payment request', () => {
  queuePaymentPrefill('a', input);
  const first = readPaymentPrefill('a');
  expect(first?.input).toEqual(input);
  expect(readPaymentPrefill('a')).toBe(first);
  expect(readPaymentPrefill('a')).toBe(first);
  acknowledgePaymentPrefill(first);
  expect(readPaymentPrefill('a')).toBeNull();
});
it('a different ledger cannot consume the current request', () => {
  queuePaymentPrefill('a', input);
  expect(readPaymentPrefill('b')).toBeNull();
  acknowledgePaymentPrefill(null);
  expect(readPaymentPrefill('a')?.input).toEqual(input);
  acknowledgePaymentPrefill(readPaymentPrefill('a'));
});
it('late commit acknowledgment does not erase a more recent request', () => {
  queuePaymentPrefill('a', input);
  const old = readPaymentPrefill('a');
  queuePaymentPrefill('a', { ...input, memo: 'new synthetic request' });
  acknowledgePaymentPrefill(old);
  const fresh = readPaymentPrefill('a');
  expect(fresh?.input.memo).toBe('new synthetic request');
  acknowledgePaymentPrefill(fresh);
});
it('duplicate commit acknowledgment is safe', () => {
  queuePaymentPrefill('a', input);
  const snapshot = readPaymentPrefill('a');
  acknowledgePaymentPrefill(snapshot);
  acknowledgePaymentPrefill(snapshot);
  expect(readPaymentPrefill('a')).toBeNull();
});

it('card transfer presentation survives render retries while loans default to advanced', () => {
  queuePaymentPrefill('a', input, 'transfer');
  expect(readPaymentPrefill('a')?.mode).toBe('transfer');
  expect(readPaymentPrefill('a')?.mode).toBe('transfer');
  acknowledgePaymentPrefill(readPaymentPrefill('a'));
  queuePaymentPrefill('a', input);
  expect(readPaymentPrefill('a')?.mode).toBe('advanced');
  acknowledgePaymentPrefill(readPaymentPrefill('a'));
});
