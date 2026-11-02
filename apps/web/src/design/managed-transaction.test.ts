// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { managedTarget } from './managed-transaction';
it('links management references to the matching editor and leaves ordinary transactions alone', () => {
  expect(managedTarget({})).toBeNull();
  expect(managedTarget({ dividend_id: 'synthetic-id' })).toEqual({
    label: '由股利管理',
    href: '/investments?tab=dividends&dividend_id=synthetic-id',
  });
  expect(managedTarget({ deposit_id: 'synthetic-id' })).toEqual({
    label: '由定存管理',
    href: '/investments?tab=deposits&deposit_id=synthetic-id',
  });
  expect(managedTarget({ deposit_id: 'x&other=1' })!.href).toContain(
    'x%26other%3D1',
  );
});
