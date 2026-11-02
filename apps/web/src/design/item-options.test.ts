// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import type { Item } from '@finmichi/core/catalog-schemas';
import {
  itemChoices,
  itemTree,
  readRecent,
  writeRecent,
  recentItemsKey,
} from './item-options';
const item = (
  id: string,
  name: string,
  parent_id: string | null = null,
  archived = false,
) =>
  ({
    id,
    name,
    parent_id,
    archived,
    ledger_id: 'ledger',
    kind: 'expense',
    currency: 'TWD',
  }) as Item;
const rows = [
  item('root', '交通'),
  item('middle', '大眾運輸', 'root'),
  item('leaf', '捷運', 'middle'),
  item('archived', '舊交通', 'root', true),
  item('standalone', '其他'),
  item('oldparent', '舊父'),
  item('oldchild', '已封存子', 'oldparent', true),
];
it('posting groups all depths by complete paths and never offers active parents or archived items', () => {
  const choices = itemChoices(rows, 'posting', null);
  expect(choices.map((c) => c.value)).toEqual([
    'leaf',
    'standalone',
    'oldparent',
  ]);
  expect(choices[0]).toMatchObject({
    group: '交通 › 大眾運輸',
    label: '交通 › 大眾運輸 › 捷運 (TWD)',
    root: '交通',
  });
  expect(
    itemChoices(rows, 'posting', null, [{ value: 'root', label: '交通' }]),
  ).toEqual([]);
  expect(itemTree(rows).parents.has('oldparent')).toBe(false);
});
it('existing historical parent/archive values remain visible but cannot be reselected', () => {
  for (const id of ['root', 'archived']) {
    expect(
      itemChoices(rows, 'posting', id).find((c) => c.value === id),
    ).toMatchObject({ disabled: true, historical: true });
    expect(
      itemChoices(rows, 'posting', id).find((c) => c.value === id)?.label,
    ).toContain('歷史科目，無法再選');
  }
});
it('filter keeps parent subtrees and archives; budgets show the full path without subtree wording', () => {
  const filter = itemChoices(rows, 'filter', null),
    budget = itemChoices(rows, 'filter', null, undefined, true);
  expect(filter).toHaveLength(rows.length);
  expect(filter.find((c) => c.value === 'root')?.label).toContain('含子科目');
  expect(filter.find((c) => c.value === 'archived')?.group).toBe('已封存');
  expect(filter.find((c) => c.value === 'archived')?.label).toContain('已封存');
  expect(budget.find((c) => c.value === 'middle')?.label).toBe(
    '交通 › 大眾運輸 (TWD)',
  );
});
it('recent storage isolates ledger/type/field, caps at eight, and drops unavailable IDs', () => {
  const map = new Map<string, string>(),
    storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
  const allowed = new Set(Array.from({ length: 12 }, (_, i) => String(i)));
  for (let i = 0; i < 12; i++)
    writeRecent(storage, 'A', 'expense:source', String(i), allowed);
  writeRecent(storage, 'A', 'expense:destination', '1', allowed);
  writeRecent(storage, 'B', 'expense:source', '2', allowed);
  expect(readRecent(storage, 'A', 'expense:source', allowed)).toEqual([
    '11',
    '10',
    '9',
    '8',
    '7',
    '6',
    '5',
    '4',
  ]);
  expect(readRecent(storage, 'A', 'expense:destination', allowed)).toEqual([
    '1',
  ]);
  expect(readRecent(storage, 'B', 'expense:source', allowed)).toEqual(['2']);
  expect(readRecent(storage, 'A', 'expense:source', new Set(['11']))).toEqual([
    '11',
  ]);
  map.set(recentItemsKey, 'not json');
  expect(readRecent(storage, 'A', 'x', allowed)).toEqual([]);
  map.set(recentItemsKey, '{"A":{"x":"bad"}}');
  expect(readRecent(storage, 'A', 'x', allowed)).toEqual([]);
  const blocked = {
    getItem: () => {
      throw Error('blocked');
    },
    setItem: () => {
      throw Error('quota');
    },
  };
  expect(() => writeRecent(blocked, 'A', 'x', '1', allowed)).not.toThrow();
  expect(readRecent(blocked, 'A', 'x', allowed)).toEqual([]);
});
