// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { marketFailureMessage } from './market-status.js';
it.each([
  'market_data_invalid',
  'source_date_missing',
  'dns_failed',
  'tls_failed',
  'connection_refused',
  'source_timeout',
  'source_unavailable',
])('explains %s in Chinese', (code) => {
  expect(marketFailureMessage(code)).toMatch(/[\u4e00-\u9fff]/);
  expect(marketFailureMessage(code)).not.toBe(marketFailureMessage(null));
});
it('unknown errors use a fixed safe description', () => {
  expect(marketFailureMessage('PRIVATE_RESPONSE')).toBe(
    marketFailureMessage(null),
  );
  expect(marketFailureMessage('PRIVATE_RESPONSE')).not.toContain(
    'PRIVATE_RESPONSE',
  );
});
