// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi, afterEach } from 'vitest';
import type { BalanceReport, BalanceItem } from '@finmichi/core/report-schemas';
import {
  accountTree,
  readAccountState,
  writeAccountState,
  accountStorageKey,
} from './overview-accounts-model';
afterEach(() => vi.unstubAllGlobals());
const item = (id: string, parent: string | null, own: string, rollup = own) =>
  ({
    id,
    parent_id: parent,
    name: id,
    kind: 'asset',
    currency: 'TWD',
    own_book_amount: own,
    book_amount: rollup,
    own_original_amount: own,
  }) as BalanceItem;
const report = {
  base_currency: 'TWD',
  totals: { assets: '9007199254740993.01', liabilities: '123.45' },
  items: [
    item('root', null, '0', '10'),
    item('branch', 'root', '0', '10'),
    item('leaf', 'branch', '10'),
    item('zero', null, '0'),
    item('cancel', null, '0'),
    item('positive', 'cancel', '5'),
    item('negative', 'cancel', '-5'),
  ],
} as BalanceReport;
it('uses exact API book totals and rollups without floating point or double counting', () => {
  const rows = accountTree(report, false);
  expect(rows.find((r) => r.id === 'asset')?.book).toBe('9007199254740993.01');
  expect(rows.find((r) => r.id === 'liability')?.book).toBe('123.45');
  expect(rows.find((r) => r.id === 'root')).toMatchObject({
    parent_id: 'asset',
    book: '10',
  });
  expect(rows.some((r) => r.id === 'zero')).toBe(false);
  expect(rows.some((r) => r.id === 'cancel')).toBe(true);
  expect(accountTree(report, true).some((r) => r.id === 'zero')).toBe(true);
});
it('keeps original currency strings and excludes equity', () => {
  const fx = {
    ...item('fx', null, '3200'),
    currency: 'USD',
    own_original_amount: '100.123456',
  };
  const rows = accountTree(
    {
      ...report,
      items: [fx, { ...item('equity', null, '1'), kind: 'equity' }],
    },
    false,
  );
  expect(rows.find((r) => r.id === 'fx')).toMatchObject({
    currency: 'USD',
    original: '100.123456',
  });
  expect(rows.some((r) => r.id === 'equity')).toBe(false);
});
it('persists expansion and zero toggle separately per ledger including explicitly collapsed groups', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  });
  expect([...readAccountState('A').expanded]).toEqual(['asset', 'liability']);
  writeAccountState('A', new Set(['asset', 'root']), true);
  writeAccountState('B', new Set(), false);
  expect(readAccountState('A')).toEqual({
    expanded: new Set(['asset', 'root']),
    showZero: true,
  });
  expect(readAccountState('B')).toEqual({
    expanded: new Set(),
    showZero: false,
  });
  values.set(accountStorageKey, 'broken');
  expect(readAccountState('A').showZero).toBe(false);
  values.set(accountStorageKey, '{"A":{"expanded":[1]}}');
  expect([...readAccountState('A').expanded]).toEqual(['asset', 'liability']);
});
it('continues rendering when localStorage is blocked or quota limited', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw Error('blocked');
    },
    setItem: () => {
      throw Error('quota');
    },
  });
  expect(readAccountState('A').showZero).toBe(false);
  expect(() => writeAccountState('A', new Set(), true)).not.toThrow();
  vi.stubGlobal('localStorage', {
    getItem: () => '{}',
    setItem: () => {
      throw Error('quota');
    },
  });
  expect(() => writeAccountState('A', new Set(), true)).not.toThrow();
});
