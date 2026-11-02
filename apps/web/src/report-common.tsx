// SPDX-License-Identifier: AGPL-3.0-only
import { notify, EmptyState } from './design/feedback';
import { useState } from 'react';
import { Button } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { apiErrorMessage } from './api';
export const todayTaipei = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export function generatedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date) + '（台北）';
}
export async function downloadReport(path: string, name: string) {
  const response = await fetch(path);
  if (!response.ok) {
    const data = (await response.json()) as { error?: string };
    throw new Error(apiErrorMessage(data.error));
  }
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  notify('已匯出報表 CSV');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ReportTree<
  T extends { id: string; parent_id: string | null; name: string },
>({
  rows,
  columns,
  defaultExpandRoots = false,
  expanded: controlledExpanded,
  onExpandedChange,
}: {
  rows: T[];
  defaultExpandRoots?: boolean;
  expanded?: Set<string>;
  onExpandedChange?: (expanded: Set<string>) => void;
  columns: {
    label: string;
    render: (row: T, mobile: boolean) => React.ReactNode;
  }[];
}) {
  const ids = new Set(rows.map((r) => r.id));
  const [localExpanded, setExpanded] = useState<Set<string>>(
    () =>
      new Set(
        defaultExpandRoots
          ? rows
              .filter((r) => !r.parent_id || !ids.has(r.parent_id))
              .map((r) => r.id)
          : [],
      ),
  );
  const expanded = controlledExpanded ?? localExpanded;
  const mobile = useMediaQuery('(max-width: 899px)');
  const children = new Map<string, T[]>();
  for (const r of rows)
    if (r.parent_id)
      children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r]);
  const pending = rows
      .filter((r) => !r.parent_id || !ids.has(r.parent_id))
      .map((row) => ({ row, depth: 0 }))
      .reverse(),
    visible: { row: T; depth: number }[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    visible.push(node);
    if (expanded.has(node.row.id))
      for (const child of [...(children.get(node.row.id) ?? [])].reverse())
        pending.push({ row: child, depth: node.depth + 1 });
  }
  const name = (row: T, depth: number) => (
    <div
      className="report-tree-name"
      style={{ paddingInlineStart: Math.min(depth, 4) * 12 }}
    >
      {children.has(row.id) ? (
        <Button
          variant="subtle"
          size="compact-sm"
          aria-label={(expanded.has(row.id) ? '收合' : '展開') + row.name}
          aria-expanded={expanded.has(row.id)}
          onClick={() => {
            const next = new Set(expanded);
            if (next.has(row.id)) next.delete(row.id);
            else next.add(row.id);
            if (onExpandedChange) onExpandedChange(next);
            else setExpanded(next);
          }}
        >
          {expanded.has(row.id) ? '▾' : '▸'}
        </Button>
      ) : (
        <span className="report-leaf" />
      )}
      <span>{row.name}</span>
    </div>
  );
  if (!rows.length)
    return (
      <EmptyState title="沒有符合條件的科目。">
        調整篩選條件，或到管理中心新增科目。
      </EmptyState>
    );
  return mobile ? (
    <div className="report-cards">
      {visible.map(({ row, depth }) => (
        <article
          className="report-card"
          key={row.id}
          data-subtotal={children.has(row.id) || undefined}
        >
          {name(row, depth)}
          <dl>
            {columns.map((c) => (
              <div key={c.label}>
                <dt>{c.label}</dt>
                <dd>{c.render(row, true)}</dd>
              </div>
            ))}
          </dl>
        </article>
      ))}
    </div>
  ) : (
    <table className="report-table">
      <thead>
        <tr>
          <th scope="col">科目</th>
          {columns.map((c) => (
            <th scope="col" key={c.label}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {visible.map(({ row, depth }) => (
          <tr key={row.id} data-subtotal={children.has(row.id) || undefined}>
            <th scope="row">{name(row, depth)}</th>
            {columns.map((c) => (
              <td key={c.label}>{c.render(row, false)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
