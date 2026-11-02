// SPDX-License-Identifier: AGPL-3.0-only
import { ItemPicker } from './design/item-picker';
import { guardNavigation } from './design/location';
import { useEffect, useState, useRef } from 'react';
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { Item, Ledger } from '@finmichi/core/catalog-schemas';
import type { Budget } from '@finmichi/core/budget-schemas';
import { api, errorMessage } from './api';
import { todayTaipei } from './report-common';
import { formatBudgetInput } from './design/format';
import { EdgeScroll } from './design/edge-scroll';
import {
  LoadingState,
  ErrorState,
  EmptyState,
  ConfirmDialog,
  notify,
} from './design/feedback';
export function Budgets({ ledger }: { ledger: Ledger }) {
  const [year, setYear] = useState(todayTaipei().slice(0, 4)),
    [items, setItems] = useState<Item[]>([]),
    [rows, setRows] = useState<Budget[]>([]),
    [draft, setDraft] = useState<Record<string, string[]>>({}),
    [annual, setAnnual] = useState<Record<string, string>>({}),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [removing, setRemoving] = useState<string | null>(null);
  const [focused, setFocused] = useState('');
  const dirty = useRef(new Set<string>()),
    [yearDraft, setYearDraft] = useState(year),
    [discard, setDiscard] = useState<(() => void) | null>(null);
  useEffect(
    () =>
      guardNavigation((proceed) => {
        if (busy) return;
        if (dirty.current.size) setDiscard(() => proceed);
        else proceed();
      }),
    [busy],
  );
  const phone = useMediaQuery('(max-width: 899px)'),
    base = `/api/ledgers/${ledger.id}/budgets`;
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    void Promise.all([
      api<Item[]>(`/api/ledgers/${ledger.id}/items?include_archived=true`),
      api<Budget[]>(base + '?year=' + encodeURIComponent(year)),
    ])
      .then(([i, b]) => {
        if (live) {
          const eligible = i.filter((x) =>
            ['income', 'expense'].includes(x.kind),
          );
          setItems(eligible);
          setRows(b);
          setDraft((old) =>
            Object.fromEntries(
              eligible.map((x) => {
                const previous = old[x.id];
                return [
                  x.id,
                  dirty.current.has(x.id) && previous
                    ? previous
                    : Array.from(
                        { length: 12 },
                        (_, m) =>
                          b.find((v) => v.item_id === x.id && v.month === m + 1)
                            ?.amount ?? '0.00',
                      ),
                ];
              }),
            ),
          );
          setSelected((v) =>
            eligible.some((x) => x.id === v) ? v : (eligible[0]?.id ?? null),
          );
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [base, ledger.id, year, revision]);
  const children = new Map<string, Item[]>();
  for (const i of items)
    if (i.parent_id)
      children.set(i.parent_id, [...(children.get(i.parent_id) ?? []), i]);
  const flat: { item: Item; depth: number }[] = [];
  const ids = new Set(items.map((x) => x.id));
  function visit(i: Item, d: number) {
    flat.push({ item: i, depth: d });
    for (const c of children.get(i.id) ?? []) visit(c, d + 1);
  }
  for (const i of items) if (!i.parent_id || !ids.has(i.parent_id)) visit(i, 0);
  function descendants(id: string): string[] {
    return (children.get(id) ?? []).flatMap((i) => [
      i.id,
      ...descendants(i.id),
    ]);
  }
  const configured = new Set(
    rows.filter((r) => /[1-9]/.test(r.amount)).map((r) => r.item_id),
  );
  const overlaps = items.some(
    (i) =>
      configured.has(i.id) && descendants(i.id).some((d) => configured.has(d)),
  );
  async function act(
    fn: () => Promise<unknown>,
    message: string,
    clearedId: string,
  ) {
    setBusy(true);
    setError('');
    try {
      await fn();
      dirty.current.delete(clearedId);
      notify(message);
      setRevision((v) => v + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function save(id: string) {
    return act(
      () =>
        api(base, 'PUT', {
          year: Number(year),
          item_id: id,
          months: (draft[id] ?? []).map((amount, m) => ({
            month: m + 1,
            amount,
          })),
        }),
      '已儲存預算',
      id,
    );
  }
  function distribute(id: string) {
    return act(
      () =>
        api(base + '/distribute', 'POST', {
          year: Number(year),
          item_id: id,
          total: annual[id] ?? '',
        }),
      '已平均分攤年度預算',
      id,
    );
  }
  function input(i: Item, m: number) {
    return (
      <TextInput
        aria-label={`${i.name} ${m + 1}月預算`}
        inputMode="decimal"
        value={
          focused === `${i.id}:${m}`
            ? (draft[i.id]?.[m] ?? '0.00')
            : formatBudgetInput(draft[i.id]?.[m] ?? '0.00')
        }
        onFocus={() => setFocused(`${i.id}:${m}`)}
        onBlur={() => setFocused('')}
        disabled={busy}
        onChange={(e) => {
          const value = e.currentTarget.value;
          dirty.current.add(i.id);
          setDraft((d) => ({
            ...d,
            [i.id]: (d[i.id] ?? Array(12).fill('0.00')).map((a, n) =>
              n === m ? value : a,
            ),
          }));
        }}
      />
    );
  }
  function actions(i: Item) {
    return (
      <Stack gap="xs">
        <TextInput
          aria-label={`${i.name} 年度總額`}
          placeholder="年度總額"
          inputMode="decimal"
          value={annual[i.id] ?? ''}
          disabled={busy}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setAnnual((a) => ({ ...a, [i.id]: v }));
          }}
        />
        <Group>
          <Button
            disabled={busy}
            onClick={() => void distribute(i.id)}
            aria-label={`平均分攤 ${i.name}`}
          >
            平均分攤
          </Button>
          <Button
            disabled={busy}
            onClick={() => void save(i.id)}
            aria-label={`儲存預算 ${i.name}`}
          >
            儲存
          </Button>
          <Button
            variant="subtle"
            color="red"
            disabled={busy}
            onClick={() => setRemoving(i.id)}
            aria-label={`清除預算 ${i.name}`}
          >
            清除
          </Button>
        </Group>
      </Stack>
    );
  }
  return (
    <Stack className="budget-editor">
      <h2>預算設定</h2>
      <form
        className="budget-year"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          const change = () => {
            dirty.current.clear();
            setYear(yearDraft);
          };
          if (yearDraft !== year && dirty.current.size)
            setDiscard(() => change);
          else if (yearDraft !== year) change();
          else setRevision((v) => v + 1);
        }}
      >
        <TextInput
          label="預算年度"
          value={yearDraft}
          inputMode="numeric"
          onChange={(e) => setYearDraft(e.currentTarget.value)}
        />
        <Button type="submit" disabled={busy}>
          載入年度
        </Button>
      </form>
      <Text>
        本位幣 {ledger.base_currency}
        ；預算採自然方向、金額不得為負。年度以分向下平均，餘數放12月；分攤後可逐月修改。
      </Text>
      {overlaps && (
        <p className="recurring-warning" role="status">
          子科目也有預算，父科目合計會包含兩者
        </p>
      )}
      {error && (
        <ErrorState message={error} retry={() => setRevision((v) => v + 1)} />
      )}
      {busy && <LoadingState label="載入預算" hasData={!!items.length} />}
      {!busy && !items.length && !error && (
        <EmptyState title="尚無收入或支出科目">
          請先在科目樹建立科目。
        </EmptyState>
      )}
      {phone ? (
        <>
          <ItemPicker
            items={items}
            mode="filter"
            purpose="budget"
            label="預算科目"
            value={selected}
            onChange={setSelected}
            data={flat.map(({ item: i, depth }) => ({
              value: i.id,
              label:
                '　'.repeat(depth) +
                i.name +
                (i.kind === 'income' ? '（收入）' : '（支出）') +
                (i.archived ? '（已封存）' : ''),
            }))}
          />
          {items
            .filter((i) => i.id === selected)
            .map((i) => (
              <section className="panel budget-mobile" key={i.id}>
                <h3>{i.name}</h3>
                {Array.from({ length: 12 }, (_, m) => (
                  <label key={m} className="budget-month">
                    <span>{m + 1}月</span>
                    {input(i, m)}
                  </label>
                ))}
                {actions(i)}
              </section>
            ))}
        </>
      ) : (
        <div className="budget-grid">
          <EdgeScroll axis="both" label="預算年度表格">
            <table className="budget-table">
              <thead>
                <tr>
                  <th>科目</th>
                  {Array.from({ length: 12 }, (_, m) => (
                    <th key={m}>{m + 1}月</th>
                  ))}
                  <th>年度分攤與儲存</th>
                </tr>
              </thead>
              <tbody>
                {flat.map(({ item: i, depth }) => (
                  <tr key={i.id}>
                    <th scope="row">
                      <span
                        style={{ paddingInlineStart: Math.min(depth, 5) * 12 }}
                      >
                        {i.name}（{i.kind === 'income' ? '收入' : '支出'}）
                        {i.archived ? '（已封存）' : ''}
                      </span>
                    </th>
                    {Array.from({ length: 12 }, (_, m) => (
                      <td key={m}>{input(i, m)}</td>
                    ))}
                    <td>{actions(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </EdgeScroll>
        </div>
      )}
      <ConfirmDialog
        opened={discard !== null}
        title="捨棄未儲存預算？"
        confirmLabel="捨棄並繼續"
        onCancel={() => setDiscard(null)}
        onConfirm={() => {
          const proceed = discard;
          dirty.current.clear();
          setDiscard(null);
          proceed?.();
        }}
        busy={busy}
      >
        尚有未儲存的月預算，繼續將捨棄變更。
      </ConfirmDialog>
      <ConfirmDialog
        opened={removing !== null}
        title="清除預算"
        confirmLabel="確認清除預算"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const id = removing;
          setRemoving(null);
          if (id)
            void act(
              () =>
                api(
                  base + '?' + new URLSearchParams({ year, item_id: id }),
                  'DELETE',
                ),
              '已清除該科目全年預算',
              id,
            );
        }}
        busy={busy}
      >
        清除該科目本年度12個月的預算，交易不受影響。
      </ConfirmDialog>
    </Stack>
  );
}
