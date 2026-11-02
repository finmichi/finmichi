// SPDX-License-Identifier: AGPL-3.0-only
import { OverviewAccounts } from './overview-accounts';
import { ReminderOverview } from '../reminders';
import { LoadingState, ErrorState, EmptyState } from './feedback';
import { useEffect, useState } from 'react';
import { Button, Stack } from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import type {
  BalanceReport,
  IncomeReport,
  CategoryReport,
} from '@finmichi/core/report-schemas';
import type { QueryPage } from '@finmichi/core/query-schemas';
import { api, errorMessage } from '../api';
import { formatMoney, formatPercent } from './format';
import {
  monthStart,
  todayTaipei,
  percent,
  units,
  negate,
} from './display-math';
import { navigate, openEntry } from './location';
import { TransactionList } from './transaction-list';
import { useTransactionRevision } from './data-revision';
interface OverviewData {
  balance: BalanceReport;
  income: IncomeReport;
  category: CategoryReport;
  recent: QueryPage;
}
function Panel({
  title,
  link,
  children,
}: {
  title: string;
  link?: { to: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="panel overview-panel">
      <div className="panel-heading">
        <h3>{title}</h3>
        {link && (
          <a
            href={link.to}
            onClick={(e) => {
              e.preventDefault();
              navigate(link.to);
            }}
          >
            {link.label} ›
          </a>
        )}
      </div>
      {children}
    </section>
  );
}
export function Overview({ ledger }: { ledger: Ledger }) {
  const revision = useTransactionRevision();
  const today = todayTaipei(),
    start = monthStart(today),
    prior = monthStart(today, -1),
    from = monthStart(today, -2),
    base = `/api/ledgers/${ledger.id}`;
  const [data, setData] = useState<OverviewData | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    void Promise.all([
      api<BalanceReport>(`${base}/reports/balance-sheet?as_of=${today}`),
      api<IncomeReport>(
        `${base}/reports/income-summary?date_from=${from}&date_to=${today}&grain=month`,
      ),
      api<CategoryReport>(
        `${base}/reports/category-statistics?date_from=${start}&date_to=${today}&kind=expense`,
      ),
      api<QueryPage>(`${base}/transactions?limit=7`),
    ])
      .then(([balance, income, category, recent]) => {
        if (live) setData({ balance, income, category, recent });
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
  }, [base, today, start, from, retry, revision]);
  const money = (v: string) =>
    formatMoney(v, ledger.base_currency, { compact: true });
  if (!data && busy) return <LoadingState label="載入總覽" />;
  if (error)
    return <ErrorState message={error} retry={() => setRetry((v) => v + 1)} />;
  if (!data || data.balance.ledger_id !== ledger.id)
    return <LoadingState label="載入總覽" />;
  const current = data.income.periods.find((p) => p.bucket_start === start),
    previous = data.income.periods.find((p) => p.bucket_start === prior);
  const income = current?.income_total ?? '0',
    expense = current?.expense_total ?? '0',
    net = current?.net_income ?? '0';
  const max = data.income.periods.reduce(
    (m, p) =>
      [p.income_total, p.expense_total].reduce((a, v) => {
        const n = units(v);
        return (n < 0n ? -n : n) > a ? (n < 0n ? -n : n) : a;
      }, m),
    0n,
  );
  const width = (v: string) => {
    const n = units(v);
    return max === 0n
      ? '0%'
      : (((n < 0n ? -n : n) * 10000n) / max)
          .toString()
          .padStart(3, '0')
          .replace(/(\d{2})$/, '.$1') + '%';
  };
  // Geometry uses bounded percentage units only; money is never converted to JS Number.
  const palette = ['expense', 'accent', 'warn', 'transfer', 'income'];
  let offset = 0;
  return (
    <Stack className="overview" aria-busy={busy}>
      <ReminderOverview ledger={ledger.id} />
      {busy && <LoadingState label="更新總覽" hasData />}
      <div className="page-heading">
        <div>
          <h2>
            {today.slice(0, 4)} 年 {Number(today.slice(5, 7))} 月
          </h2>
          <p>
            資料截至 {today} · 本位幣 {ledger.base_currency}
          </p>
        </div>
        <Button className="desktop-action" onClick={() => openEntry()}>
          ＋ 記一筆
        </Button>
      </div>
      <div className="kpi-grid">
        <section className="panel kpi kpi-hero">
          <h3>淨值</h3>
          <div className="kpi-value num">
            {money(data.balance.totals.net_worth)}
          </div>
          <p>
            資產 {money(data.balance.totals.assets)} · 負債{' '}
            {money(data.balance.totals.liabilities)}
          </p>
        </section>
        <section className="panel kpi">
          <h3>本月收入</h3>
          <div className="kpi-value num kind-text-income">
            {formatMoney(income, ledger.base_currency, {
              compact: true,
              sign: 'always',
            })}
          </div>
          <p>上月 {money(previous?.income_total ?? '0')}</p>
        </section>
        <section className="panel kpi">
          <h3>本月支出</h3>
          <div className="kpi-value num kind-text-expense">
            {money(negate(expense))}
          </div>
          <p>上月 {money(previous?.expense_total ?? '0')}</p>
        </section>
        <section className="panel kpi">
          <h3>本月結餘</h3>
          <div className="kpi-value num">
            {formatMoney(net, ledger.base_currency, {
              compact: true,
              sign: 'always',
            })}
          </div>
          <p>儲蓄率 {formatPercent(percent(net, income))}</p>
        </section>
      </div>
      {data.recent.totals.count === 0 && (
        <EmptyState
          title="還沒有交易"
          action={
            <>
              <Button onClick={() => openEntry()}>＋ 記一筆</Button>
              <Button
                variant="subtle"
                onClick={() => navigate('/admin/import')}
              >
                前往匯入
              </Button>
            </>
          }
        >
          按「＋ 記一筆」開始，或到管理中心匯入資料。
        </EmptyState>
      )}
      <div className="overview-columns">
        <div className="overview-column">
          <Panel title="近三個月收支">
            <div className="panel-body">
              <div className="chart-legend">
                <span className="kind-text-income">● 收入</span>
                <span className="kind-text-expense">● 支出</span>
              </div>
              {data.income.periods.map((p) => (
                <div key={p.bucket_start} className="overview-bar-row">
                  <span className="month-label">{p.label}</span>
                  <div className="bar-pair">
                    <div className="bar-track">
                      <div
                        className="bar-fill income-fill"
                        style={{ width: width(p.income_total) }}
                      />
                    </div>
                    <div className="bar-track">
                      <div
                        className="bar-fill expense-fill"
                        style={{ width: width(p.expense_total) }}
                      />
                    </div>
                  </div>
                  <div className="num">
                    {money(p.income_total)}
                    <br />
                    {money(p.expense_total)}
                  </div>
                </div>
              ))}
              <p className="subtle">
                各月收入與支出，含營業及業外；負值以絕對長度呈現，右側為帶號原值。
              </p>
            </div>
          </Panel>
          <Panel
            title="最近交易"
            link={{ to: '/transactions', label: '查看全部' }}
          >
            {data.recent.items.length ? (
              <TransactionList
                rows={data.recent.items}
                currency={ledger.base_currency}
                grouped={false}
              />
            ) : (
              <p className="panel-body subtle">目前沒有交易。</p>
            )}
          </Panel>
        </div>
        <div className="overview-column">
          <Panel
            title="本月支出分類"
            link={{ to: '/reports/category-statistics', label: '分類統計' }}
          >
            <div className="panel-body">
              <div className="category-preview">
                {data.category.pie_available ? (
                  <svg
                    viewBox="0 0 140 140"
                    role="img"
                    aria-label="本月支出分類圓餅圖"
                  >
                    <circle
                      cx="70"
                      cy="70"
                      r="48"
                      fill="none"
                      stroke="var(--surface-2)"
                      strokeWidth="18"
                    />
                    {data.category.pie.map((r, i) => {
                      const size = Number(r.percentage ?? '0') * 3.015928947;
                      const startOffset = offset;
                      offset += size;
                      return (
                        <circle
                          key={r.id}
                          cx="70"
                          cy="70"
                          r="48"
                          fill="none"
                          stroke={`var(--${palette[i % palette.length]})`}
                          strokeWidth="18"
                          strokeDasharray={`${size} 301.5928947`}
                          strokeDashoffset={-startOffset}
                          transform="rotate(-90 70 70)"
                        />
                      );
                    })}
                    <text x="70" y="68" textAnchor="middle">
                      本月支出
                    </text>
                    <text className="num" x="70" y="86" textAnchor="middle">
                      {money(data.category.total_amount)}
                    </text>
                  </svg>
                ) : (
                  <p>
                    {data.category.pie_reason === 'negative_items'
                      ? '含負值，請參考長條圖與明細'
                      : data.category.pie_reason === 'negative_total'
                        ? '不適用（總額為負）'
                        : '不適用（總額為 0）'}
                  </p>
                )}
                <div>
                  {data.category.items
                    .filter((i) => !i.parent_id)
                    .map((r) => (
                      <div className="category-preview-row" key={r.id}>
                        <span>{r.name}</span>
                        <span className="num">
                          {money(r.rollup_amount)}{' '}
                          <small>{formatPercent(r.percentage)}</small>
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </Panel>
          <div className="overview-accounts">
            <Panel
              title="帳戶餘額"
              link={{
                to: '/reports/balance-sheet?as_of=' + today,
                label: '資產負債表',
              }}
            >
              <OverviewAccounts
                key={ledger.id}
                ledger={ledger.id}
                currency={ledger.base_currency}
                report={data.balance}
              />
            </Panel>
          </div>
        </div>
      </div>
    </Stack>
  );
}
