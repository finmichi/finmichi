// SPDX-License-Identifier: AGPL-3.0-only
import type { ItemSummary } from '@finmichi/core/query-schemas';
import { add, negate } from './display-math';

// Own entry amounts only: rollups would count descendants twice.
export function queryProfit(
  items: Pick<ItemSummary, 'kind' | 'natural_amount'>[],
) {
  const income = add(
    items.filter((i) => i.kind === 'income').map((i) => i.natural_amount),
  );
  const expense = add(
    items.filter((i) => i.kind === 'expense').map((i) => i.natural_amount),
  );
  return { income, expense, net: add([income, negate(expense)]) };
}
