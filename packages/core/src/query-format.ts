// SPDX-License-Identifier: AGPL-3.0-only
import type { QueryRow } from './query-schemas.js';
export function transactionDirection(row: Pick<QueryRow, 'entries'>): string {
  if (row.entries.length !== 2) return '多筆分錄';
  const source = row.entries.find((e) => e.base_amount.startsWith('-')),
    target = row.entries.find((e) => !e.base_amount.startsWith('-'));
  return `${source?.item_name ?? '—'} → ${target?.item_name ?? '—'}`;
}
