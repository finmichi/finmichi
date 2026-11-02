// SPDX-License-Identifier: AGPL-3.0-only
import type { BalanceItem } from '@finmichi/core/report-schemas';
import { negate } from './display-math';
// SQL book amounts are already natural. Only original-currency signed balances need presentation reversal.
export const naturalOriginalAmount = (
  kind: BalanceItem['kind'],
  value: string,
) => (kind === 'asset' ? value : negate(value));
export function balanceOriginalAmount(row: BalanceItem) {
  return naturalOriginalAmount(
    row.kind,
    row.original_balances.find((v) => v.currency === row.currency)
      ?.original_amount ?? row.own_original_amount,
  );
}
