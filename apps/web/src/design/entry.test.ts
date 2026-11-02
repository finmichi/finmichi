// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { entryUrl } from './location';
it('entry routes preserve the original path, AND filters and unicode when opening and closing', () => {
  const original =
    '/transactions?kind=expense&keyword=' + encodeURIComponent('合成 茶');
  const opened = entryUrl(original, 'new');
  expect(opened).toContain('kind=expense');
  expect(
    new URL(opened, 'https://local.invalid').searchParams.get('keyword'),
  ).toBe('合成 茶');
  expect(
    new URL(
      entryUrl(opened, null),
      'https://local.invalid',
    ).searchParams.toString(),
  ).toBe(new URL(original, 'https://local.invalid').searchParams.toString());
  expect(entryUrl('/admin/items?entry=old', 'transaction-id')).toBe(
    '/admin/items?entry=transaction-id',
  );
  expect(entryUrl('/?entry=new', null)).toBe('/');
});
