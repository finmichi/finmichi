// SPDX-License-Identifier: AGPL-3.0-only
import type { Item } from '@finmichi/core/catalog-schemas';
export type ItemChoice = { value: string; label: string; disabled?: boolean };
export type PickerMode = 'posting' | 'filter';
export const recentItemsKey = 'finmichi-recent-items';
const kindNames: Record<string, string> = {
  asset: '資產',
  liability: '負債',
  income: '收入',
  expense: '支出',
  equity: '權益',
};
export function itemTree(items: Item[]) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const parents = new Set(
    items.filter((i) => !i.archived && i.parent_id).map((i) => i.parent_id!),
  );
  function lineage(item: Item) {
    const path = [item];
    const seen = new Set([item.id]);
    while (path[0]!.parent_id) {
      const p = byId.get(path[0]!.parent_id!);
      if (!p || seen.has(p.id)) break;
      seen.add(p.id);
      path.unshift(p);
    }
    return path;
  }
  return {
    parents,
    lineage,
    path: (i: Item) =>
      lineage(i)
        .map((p) => p.name)
        .join(' › '),
  };
}
export function itemChoices(
  items: Item[],
  mode: PickerMode,
  current: string | null | undefined,
  data?: ItemChoice[],
  budget = false,
) {
  const tree = itemTree(items);
  const eligible = new Map<string, ItemChoice>(
    (
      data ??
      items.map((i) => ({ value: i.id, label: `${i.name} (${i.currency})` }))
    ).map((v) => [v.value, v]),
  );
  return items.flatMap((i) => {
    const supplied = eligible.get(i.id);
    if (!supplied && i.id !== current) return [];
    const historical =
      mode === 'posting' && (i.archived || tree.parents.has(i.id));
    if (historical && i.id !== current) return [];
    const path = tree.path(i);
    const original = (
      supplied?.label ?? `${i.name} (${i.currency})`
    ).trimStart();
    const label = original.includes(i.name)
      ? original.replace(i.name, path)
      : path;
    return [
      {
        value: i.id,
        label:
          label +
          (mode === 'filter' && i.archived && !label.includes('已封存')
            ? '（已封存）'
            : '') +
          (historical
            ? '（歷史科目，無法再選）'
            : mode === 'filter' && tree.parents.has(i.id) && !budget
              ? '（含子科目）'
              : ''),
        disabled: historical || !!supplied?.disabled,
        group: i.archived
          ? '已封存'
          : tree.lineage(i).length > 1
            ? tree
                .lineage(i)
                .slice(0, -1)
                .map((p) => p.name)
                .join(' › ')
            : (kindNames[i.kind] ?? '其他'),
        root: i.archived
          ? '已封存'
          : tree.lineage(i).length > 1 || tree.parents.has(i.id)
            ? tree.lineage(i)[0]!.name
            : (kindNames[i.kind] ?? '其他'),
        depth: tree.lineage(i).length - 1,
        parent: tree.parents.has(i.id),
        historical,
      },
    ];
  });
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
function recentStore(storage: StorageLike) {
  const raw: unknown = JSON.parse(storage.getItem(recentItemsKey) ?? '{}');
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, Record<string, string[]>>)
    : {};
}
export function readRecent(
  storage: StorageLike,
  ledger: string,
  bucket: string,
  allowed: Set<string>,
) {
  try {
    const ids: unknown = recentStore(storage)[ledger]?.[bucket];
    return Array.isArray(ids)
      ? [
          ...new Set(
            ids.filter(
              (id): id is string => typeof id === 'string' && allowed.has(id),
            ),
          ),
        ].slice(0, 8)
      : [];
  } catch {
    return [];
  }
}
export function writeRecent(
  storage: StorageLike,
  ledger: string,
  bucket: string,
  id: string,
  allowed: Set<string>,
) {
  try {
    if (!allowed.has(id)) return;
    const all = recentStore(storage);
    all[ledger] = {
      ...all[ledger],
      [bucket]: [
        id,
        ...readRecent(storage, ledger, bucket, allowed).filter((v) => v !== id),
      ].slice(0, 8),
    };
    storage.setItem(recentItemsKey, JSON.stringify(all));
  } catch {
    /* Storage is optional, including private browsing and quota failures. */
  }
}
