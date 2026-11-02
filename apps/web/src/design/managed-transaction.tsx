// SPDX-License-Identifier: AGPL-3.0-only
import { Button } from '@mantine/core';
import { navigate } from './location';
export interface ManagedReference {
  dividend_id?: string | null;
  deposit_id?: string | null;
}
export function managedTarget(row: ManagedReference) {
  if (row.dividend_id)
    return {
      label: '由股利管理',
      href:
        '/investments?tab=dividends&dividend_id=' +
        encodeURIComponent(row.dividend_id),
    };
  if (row.deposit_id)
    return {
      label: '由定存管理',
      href:
        '/investments?tab=deposits&deposit_id=' +
        encodeURIComponent(row.deposit_id),
    };
  return null;
}
export function ManagedTransactionLink({ row }: { row: ManagedReference }) {
  const target = managedTarget(row);
  return target ? (
    <Button
      component="a"
      href={target.href}
      variant="subtle"
      size="compact-sm"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        navigate(target.href);
      }}
    >
      {target.label} · 前往編輯
    </Button>
  ) : null;
}
