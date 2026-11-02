// SPDX-License-Identifier: AGPL-3.0-only
import { useMediaQuery } from '@mantine/hooks';
import { Fragment, useState } from 'react';
import { Button } from '@mantine/core';
import type { QueryRow } from '@finmichi/core/query-schemas';
import { transactionDirection } from '@finmichi/core/query-format';
import { EdgeScroll } from './edge-scroll';
import { formatDate, formatMoney, formatRate, formatFullRate } from './format';
import { negate, units } from './display-math';
import { openEntry } from './location';
export const kindNames = {
  income: '收入',
  expense: '支出',
  transfer: '轉帳',
  adjustment: '調整',
};
export function KindChip({ kind }: { kind: QueryRow['kind'] }) {
  return <span className={'kind-chip kind-' + kind}>{kindNames[kind]}</span>;
}
export const signedTransactionAmount = (row: QueryRow) =>
  row.kind === 'expense'
    ? negate(row.transaction_amount)
    : row.transaction_amount;
function TxMoney({
  row,
  currency,
  compact = false,
}: {
  row: QueryRow;
  currency: string;
  compact?: boolean;
}) {
  return (
    <span className={'num kind-text-' + row.kind}>
      {formatMoney(signedTransactionAmount(row), currency, {
        compact,
        sign: row.kind === 'income' ? 'always' : 'auto',
      })}
    </span>
  );
}
export function TransactionList({
  rows,
  currency,
  grouped = true,
  sortable = false,
  dayNets,
  dayNetLabel = '日淨額',
  sort: controlledSort,
  onSortChange,
}: {
  rows: QueryRow[];
  currency: string;
  grouped?: boolean;
  sortable?: boolean;
  dayNets?: Record<string, string>;
  dayNetLabel?: string;
  sort?: 'date-desc' | 'date-asc' | 'amount-desc';
  onSortChange?: (sort: 'date-desc' | 'date-asc' | 'amount-desc') => void;
}) {
  const desktop = useMediaQuery('(min-width: 900px)', false, {
    getInitialValueInEffect: false,
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [localSort, setLocalSort] = useState<
      'date-desc' | 'date-asc' | 'amount-desc'
    >('date-desc');
  const sort = controlledSort ?? localSort;
  const setSort = (value: typeof sort) => {
    setLocalSort(value);
    onSortChange?.(value);
  };
  const list = [...rows].sort((a, b) => {
    if (sort === 'amount-desc') {
      const diff = units(b.transaction_amount) - units(a.transaction_amount);
      if (diff !== 0n) return diff > 0n ? 1 : -1;
    }
    const order =
      b.occurred_on.localeCompare(a.occurred_on) ||
      b.created_at.localeCompare(a.created_at) ||
      b.id.localeCompare(a.id);
    return sort === 'date-asc' ? -order : order;
  });
  function toggle(id: string) {
    setExpanded((old) => {
      const n = new Set(old);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function edit(row: QueryRow) {
    openEntry(row.id);
  }
  const entries = (row: QueryRow) => (
    <div className="entry-breakdown">
      {row.entries.map((e) => (
        <div key={e.entry_position}>
          <strong>{e.item_name}</strong>
          <span>原幣 {formatMoney(e.amount, e.currency)}</span>
          <span title={formatFullRate(e.exchange_rate)}>
            匯率 {formatRate(e.exchange_rate)}
          </span>
          <span>本位幣 {formatMoney(e.base_amount, currency)}</span>
        </div>
      ))}
    </div>
  );
  const expand = (row: QueryRow) =>
    row.entries.length <= 2 ? null : (
      <Button
        variant="subtle"
        size="xs"
        aria-expanded={expanded.has(row.id)}
        onClick={(e) => {
          e.stopPropagation();
          toggle(row.id);
        }}
      >
        {expanded.has(row.id) ? '收起分錄' : '展開多筆分錄'}
      </Button>
    );
  const fx = (row: QueryRow) =>
    row.entries
      .filter((e) => e.currency !== currency)
      .map((e) => (
        <div
          className="tx-note num"
          key={e.entry_position}
          title={formatFullRate(e.exchange_rate)}
        >
          {formatMoney(e.amount, e.currency)} · 匯率{' '}
          {formatRate(e.exchange_rate)}
        </div>
      ));
  return (
    <>
      {sortable && desktop && (
        <div className="loaded-sort">
          <label>
            已載入交易排序{' '}
            <select
              aria-label="已載入交易排序"
              value={sort}
              onChange={(e) => setSort(e.currentTarget.value as typeof sort)}
            >
              <option value="date-desc">日期由新到舊</option>
              <option value="date-asc">日期由舊到新</option>
              <option value="amount-desc">交易金額由大到小</option>
            </select>
          </label>
          <span>排序僅套用已載入資料；載入更多後一併排序。</span>
        </div>
      )}
      {desktop && (
        <div className="desktop-transactions">
          <EdgeScroll axis="both" label="交易表格" className="table-scroll">
            <table className="tx-table">
              <thead>
                <tr>
                  <th
                    aria-sort={
                      sort === 'amount-desc'
                        ? 'none'
                        : sort === 'date-asc'
                          ? 'ascending'
                          : 'descending'
                    }
                  >
                    {sortable ? (
                      <button
                        onClick={() =>
                          setSort(
                            sort === 'date-desc' ? 'date-asc' : 'date-desc',
                          )
                        }
                      >
                        日期 ↕
                      </button>
                    ) : (
                      '日期'
                    )}
                  </th>
                  <th>類別</th>
                  <th>摘要</th>
                  <th>來源 → 目的</th>
                  <th>收付人／專案</th>
                  <th className="numeric">金額</th>
                </tr>
              </thead>
              <tbody>
                {list.map((row) => (
                  <Fragment key={row.id}>
                    <tr
                      data-testid="query-transaction"
                      onClick={() => edit(row)}
                    >
                      <td className="num">
                        {formatDate(row.occurred_on, 'short')}
                      </td>
                      <td>
                        <KindChip kind={row.kind} />
                        {row.deposit_id && (
                          <span className="kind-chip">定存</span>
                        )}
                        {row.security_trade_id && (
                          <span className="kind-chip">股票</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="tx-edit"
                          onClick={(e) => {
                            e.stopPropagation();
                            edit(row);
                          }}
                        >
                          {row.memo || '（無摘要）'}
                        </button>
                        {fx(row)}
                        {row.invoice_no && (
                          <div className="tx-note">發票：{row.invoice_no}</div>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div>{transactionDirection(row)}</div>
                        {expand(row)}
                      </td>
                      <td>
                        {row.payee_name || row.project_name ? (
                          <>
                            {row.payee_name ?? '—'}
                            {row.project_name && (
                              <div className="tx-note">{row.project_name}</div>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="numeric">
                        <TxMoney row={row} currency={currency} />
                        {row.selected_net_amount !== null && (
                          <div className="tx-note">
                            所選淨額{' '}
                            {formatMoney(row.selected_net_amount, currency)}
                          </div>
                        )}
                      </td>
                    </tr>
                    {expanded.has(row.id) && (
                      <tr className="tx-expanded">
                        <td colSpan={6}>{entries(row)}</td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </EdgeScroll>
        </div>
      )}
      {!desktop && (
        <div className="mobile-transactions">
          {[...new Set(list.map((r) => r.occurred_on))].map((date) => {
            const day = list.filter((r) => r.occurred_on === date),
              net = dayNets?.[date];
            return (
              <section key={date}>
                {grouped && (
                  <div className="day-heading">
                    <span>{formatDate(date, 'group')}</span>
                    <span className="num">
                      {dayNetLabel}{' '}
                      {formatMoney(net ?? null, currency, {
                        compact: true,
                        sign: 'always',
                      })}
                    </span>
                  </div>
                )}
                <div className="tx-card-list">
                  {day.map((row) => (
                    <article
                      className="tx-card"
                      key={row.id}
                      data-testid="query-transaction"
                      onClick={() => edit(row)}
                    >
                      <div className="tx-card-line">
                        <div className="tx-card-main">
                          <button
                            className="tx-edit"
                            onClick={(e) => {
                              e.stopPropagation();
                              edit(row);
                            }}
                          >
                            {row.memo || '（無摘要）'}
                          </button>
                          <div className="tx-meta">
                            {transactionDirection(row)}
                            {row.payee_name ? ' · ' + row.payee_name : ''}
                          </div>
                          <KindChip kind={row.kind} />
                          {row.deposit_id && (
                            <span className="kind-chip">定存</span>
                          )}
                          {row.security_trade_id && (
                            <span className="kind-chip">股票</span>
                          )}
                        </div>
                        <TxMoney row={row} currency={currency} compact />
                      </div>
                      {fx(row)}
                      {row.project_name && (
                        <div className="tx-note">專案：{row.project_name}</div>
                      )}
                      {row.invoice_no && (
                        <div className="tx-note">發票：{row.invoice_no}</div>
                      )}
                      {row.selected_net_amount !== null && (
                        <div className="tx-note">
                          所選科目淨額：
                          {formatMoney(row.selected_net_amount, currency)}
                        </div>
                      )}
                      {expand(row)}
                      {expanded.has(row.id) && entries(row)}
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
