// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Button, Group, Text } from '@mantine/core';
import type { StockHolding } from '@finmichi/core';
import { stockUnits } from '@finmichi/core/securities-math';
import { EdgeScroll } from './design/edge-scroll';
import { formatMoney, formatPercent, formatRate } from './design/format';
import { navigate } from './design/location';
export function HoldingTable({
  holdings,
  asOf,
  onEntry,
  onEdit,
}: {
  holdings: StockHolding[];
  asOf: string;
  onEntry: (id: string) => void;
  onEdit: (h: StockHolding) => void;
}) {
  const [sort, setSort] = useState('name'),
    [descending, setDescending] = useState(false);
  const columns = [
    ['name', '股票'],
    ['quantity', '股數'],
    ['average_cost', '平均成本'],
    ['cost', '帳面成本'],
    ['market_amount', '市值'],
    ['unrealized_gain', '未實現損益'],
    ['return_percent', '報酬率'],
    ['price_date', '行情日期'],
  ] as const;
  const rows = [...holdings].sort((a, b) => {
    let n = 0;
    if (sort === 'name' || sort === 'price_date')
      n = String(a[sort] ?? '').localeCompare(String(b[sort] ?? ''));
    else {
      const av = stockUnits(String(a[sort as keyof StockHolding] ?? '0'), 6),
        bv = stockUnits(String(b[sort as keyof StockHolding] ?? '0'), 6);
      n = av < bv ? -1 : av > bv ? 1 : 0;
    }
    return (
      (descending ? -n : n) ||
      a.symbol.localeCompare(b.symbol) ||
      a.id.localeCompare(b.id)
    );
  });
  return (
    <div className="stock-desktop">
      <EdgeScroll axis="x" label="持股表格">
        <table className="holding-table">
          <thead>
            <tr>
              {columns.map(([key, title]) => (
                <th
                  key={key}
                  scope="col"
                  aria-sort={
                    sort === key
                      ? descending
                        ? 'descending'
                        : 'ascending'
                      : 'none'
                  }
                >
                  <Button
                    variant="subtle"
                    size="compact-sm"
                    aria-label={'依' + title + '排序'}
                    onClick={() => {
                      if (sort === key) setDescending((v) => !v);
                      else {
                        setSort(key);
                        setDescending(false);
                      }
                    }}
                  >
                    {title}
                    {sort === key ? (descending ? ' ↓' : ' ↑') : ''}
                  </Button>
                </th>
              ))}
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.id}>
                <th scope="row">
                  <a
                    href={`/investments/${h.id}?as_of=${asOf}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/investments/${h.id}?as_of=${asOf}`);
                    }}
                  >
                    {h.symbol} {h.name}
                  </a>
                  {h.archived ? '（已封存）' : ''}
                </th>
                <td>{h.quantity}</td>
                <td>{formatRate(h.average_cost)}</td>
                <td>{formatMoney(h.cost)}</td>
                <td>{formatMoney(h.market_amount)}</td>
                <td>{formatMoney(h.unrealized_gain)}</td>
                <td>{formatPercent(h.return_percent)}</td>
                <td>
                  <Text size="sm">{h.price_date ?? '無行情，沿用帳面值'}</Text>
                  {h.stale && (
                    <Text size="xs" style={{ color: 'var(--warn)' }}>
                      行情已過期{h.estimated_days ? '（依平日估算）' : ''}
                    </Text>
                  )}
                </td>
                <td>
                  <Group wrap="nowrap">
                    <Button
                      size="xs"
                      disabled={h.archived}
                      onClick={() => onEntry(h.id)}
                      aria-label={'股票記帳 ' + h.name}
                    >
                      股票記帳
                    </Button>
                    <Button
                      variant="light"
                      size="xs"
                      onClick={() => onEdit(h)}
                      aria-label={'編輯證券 ' + h.name}
                    >
                      設定
                    </Button>
                    <Button
                      variant="subtle"
                      size="xs"
                      onClick={() =>
                        navigate(
                          '/investments?view=dividends&security_id=' + h.id,
                        )
                      }
                    >
                      股利
                    </Button>
                  </Group>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EdgeScroll>
    </div>
  );
}
