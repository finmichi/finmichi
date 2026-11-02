// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { migrateLegacyPreferences } from './storage-migration';
function storage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
    clear: () => values.clear(),
  } satisfies Storage;
}
describe('preference migration', () => {
  it('moves all old keys, including empty values, once and preserves unrelated keys', () => {
    const s = storage({
      'life-ledger-ledger': 'synthetic',
      'life-ledger-theme': 'dark',
      'life-ledger-extra': '',
      other: 'keep',
    });
    migrateLegacyPreferences(s);
    expect(s.getItem('finmichi-ledger')).toBe('synthetic');
    expect(s.getItem('finmichi-theme')).toBe('dark');
    expect(s.getItem('finmichi-extra')).toBe('');
    expect(s.getItem('life-ledger-ledger')).toBeNull();
    expect(s.getItem('life-ledger-theme')).toBeNull();
    expect(s.getItem('life-ledger-extra')).toBeNull();
    expect(s.getItem('other')).toBe('keep');
    migrateLegacyPreferences(s);
    expect(s.length).toBe(4);
  });
  it('keeps existing new values authoritative, including an empty value', () => {
    const s = storage({ 'life-ledger-theme': 'dark', 'finmichi-theme': '' });
    migrateLegacyPreferences(s);
    expect(s.getItem('finmichi-theme')).toBe('');
    expect(s.getItem('life-ledger-theme')).toBe('dark');
  });
  it('preserves the old value if writing fails and tolerates blocked storage', () => {
    const s = storage({ 'life-ledger-theme': 'dark' });
    s.setItem = () => {
      throw new Error('synthetic quota');
    };
    expect(() => migrateLegacyPreferences(s)).not.toThrow();
    expect(s.getItem('life-ledger-theme')).toBe('dark');
    Object.defineProperty(s, 'length', {
      get: () => {
        throw new Error('blocked');
      },
    });
    expect(() => migrateLegacyPreferences(s)).not.toThrow();
  });
});
