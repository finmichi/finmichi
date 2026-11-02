// SPDX-License-Identifier: AGPL-3.0-only
import type { BalanceReport } from '@finmichi/core/report-schemas';
import { units } from './display-math';
export interface AccountNode {
  id: string;
  parent_id: string | null;
  name: string;
  book: string;
  original: string | null;
  currency: string;
}
export const accountStorageKey = 'finmichi-overview-expanded';
export const defaultAccountExpansion = () => new Set(['asset', 'liability']);
export function readAccountState(ledger: string): {
  expanded: Set<string>;
  showZero: boolean;
} {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(accountStorageKey) ?? '{}',
    );
    if (value && typeof value === 'object' && Object.hasOwn(value, ledger)) {
      const state = (value as Record<string, unknown>)[ledger];
      if (
        state &&
        typeof state === 'object' &&
        'expanded' in state &&
        Array.isArray(state.expanded) &&
        state.expanded.every((v: unknown) => typeof v === 'string')
      )
        return {
          expanded: new Set(state.expanded),
          showZero: 'showZero' in state && state.showZero === true,
        };
    }
  } catch {
    /* Storage may be unavailable or contain old/corrupt data. */
  }
  return { expanded: defaultAccountExpansion(), showZero: false };
}
export function writeAccountState(
  ledger: string,
  expanded: Set<string>,
  showZero: boolean,
) {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(accountStorageKey) ?? '{}',
    );
    const states =
      value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    localStorage.setItem(
      accountStorageKey,
      JSON.stringify({
        ...states,
        [ledger]: { expanded: [...expanded], showZero },
      }),
    );
  } catch {
    /* A disabled/quota-limited storage must not block the view. */
  }
}
export function accountTree(
  report: BalanceReport,
  showZero: boolean,
): AccountNode[] {
  const items = report.items.filter(
    (i) => i.kind === 'asset' || i.kind === 'liability',
  );
  const keep = new Set(
    items
      .filter(
        (i) =>
          showZero ||
          units(i.own_book_amount) !== 0n ||
          units(i.book_amount) !== 0n ||
          units(i.own_original_amount) !== 0n,
      )
      .map((i) => i.id),
  );
  const byId = new Map(items.map((i) => [i.id, i]));
  // Retain ancestors of nonzero descendants even when opposite balances cancel.
  for (const id of [...keep]) {
    let parent = byId.get(id)?.parent_id;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      keep.add(parent);
      parent = byId.get(parent)?.parent_id;
    }
  }
  return [
    ...(['asset', 'liability'] as const).map((kind) => ({
      id: kind,
      parent_id: null,
      name: kind === 'asset' ? '資產' : '負債',
      book: report.totals[kind === 'asset' ? 'assets' : 'liabilities'],
      original: null,
      currency: report.base_currency,
    })),
    ...items
      .filter((i) => keep.has(i.id))
      .map((i) => ({
        id: i.id,
        parent_id: i.parent_id && byId.has(i.parent_id) ? i.parent_id : i.kind,
        name: i.name,
        book: i.book_amount,
        original:
          i.currency !== report.base_currency ? i.own_original_amount : null,
        currency: i.currency,
      })),
  ];
}
