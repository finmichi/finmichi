// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { tokenHash, newToken, isAllowed, sameOrigin } from './index.js';
describe('authentication policy', () => {
  it('matches exact subjects and origins', () => {
    expect(isAllowed('allowed', ['allowed'])).toBe(true);
    expect(isAllowed('Allowed', ['allowed'])).toBe(false);
    expect(sameOrigin(undefined, 'https://localhost:8443')).toBe(false);
    expect(sameOrigin('https://evil.invalid', 'https://localhost:8443')).toBe(
      false,
    );
    expect(sameOrigin('https://localhost:8443', 'https://localhost:8443')).toBe(
      true,
    );
  });
  it('creates 256-bit tokens and stores only a distinct deterministic SHA-256', () => {
    const token = newToken();
    expect(Buffer.from(token, 'base64url').length).toBe(32);
    expect(tokenHash(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash(token)).not.toBe(token);
    expect(tokenHash(token)).toBe(tokenHash(token));
    expect(newToken()).not.toBe(token);
  });
});
