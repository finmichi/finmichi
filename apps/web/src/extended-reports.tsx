// SPDX-License-Identifier: AGPL-3.0-only
import { ItemPicker } from './design/item-picker';
import CashForecast from './cash-forecast';
import { forecastFiltersFromLocation } from './design/report-state';
import { useEffect, useState, lazy, Suspense, Fragment } from 'react';
import {
  Button,
  Select,
  SegmentedControl,
  Stack,
  TextInput,
  Text,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { Ledger, Item } from '@finmichi/core/catalog-schemas';
import type {
  ProfitItem,
  ProfitLossReport,
  ProfitValues,
  NetWorthFlowReport,
  AccountLedgerReport,
} from '@finmichi/core/report-schemas';
import { api, errorMessage } from './api';
import { LoadingState, ErrorState, EmptyState } from './design/feedback';
import { useLocation, navigate, openEntry } from './design/location';
import {
  extendedFiltersFromLocation,
  extendedFiltersUrl,
  flowViewFromLocation,
  accountFiltersFromLocation,
} from './design/report-state';
import {
  formatMoney,
  formatRate,
  formatPercent,
  formatDate,
} from './design/format';
import { useReport } from './report-hooks';
import { EdgeScroll } from './design/edge-scroll';
import {
  todayTaipei,
  generatedAt,
  downloadReport,
  ReportTree,
} from './report-common';
const FlowChart = lazy(() => import('./flow-chart'));
const grainOptions = [
  { value: 'day', label: '日' },
  { value: 'month', label: '月' },
  { value: 'quarter', label: '季' },
  { value: 'year', label: '年' },
];
const sectionLabels = {
  operating_income: '營業收入',
  operating_expense: '營業支出',
  non_operating_income: '業外收入',
  non_operating_expense: '業外支出',
};
function Dates({
  draft,
  change,
}: {
  draft: { date_from: string; date_to: string };
  change: (k: string, v: string) => void;
}) {
  return (
    <>
      <TextInput
        type="date"
        label="報表起日"
        required
        value={draft.date_from}
        onChange={(e) => change('date_from', e.currentTarget.value)}
      />
      <TextInput
        type="date"
        label="報表迄日"
        required
        value={draft.date_to}
        onChange={(e) => change('date_to', e.currentTarget.value)}
      />
    </>
  );
}
function Export({
  url,
  label = '匯出報表 CSV',
}: {
  url: string;
  label?: string;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        variant="default"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void downloadReport(url, 'report.csv')
            .catch((e) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        {label}
      </Button>
      {error && <ErrorState message={error} />}
    </>
  );
}
function Loss({ value, currency }: { value: string; currency: string }) {
  return (
    <span
      className={
        value.startsWith('-') ? 'report-loss report-money' : 'report-money'
      }
    >
      {formatMoney(value, currency)}
      {value.startsWith('-') && <strong> 虧損</strong>}
    </span>
  );
}
function ProfitLossTable({
  report,
  currency,
}: {
  report: ProfitLossReport;
  currency: string;
}) {
  const roots = report.sections.flatMap((section) => {
    const ids = new Set(section.items.map((item) => item.id));
    return section.items
      .filter((item) => !item.parent_id || !ids.has(item.parent_id))
      .map((item) => item.id);
  });
  const [expanded, setExpanded] = useState(() => new Set(roots));
  const columns = [...report.periods, report.totals];
  const metric = (key: keyof ProfitValues, label: string, tone = 'section') => (
    <tr className={'profit-row-' + tone} key={key}>
      <th scope="row">{label}</th>
      {columns.map((period, index) => (
        <td key={index}>
          {key === 'operating_margin' ? (
            formatPercent(period[key])
          ) : [
              'operating_profit',
              'non_operating_profit',
              'net_income',
            ].includes(key) ? (
            <Loss value={period[key] as string} currency={currency} />
          ) : (
            <span className="report-money">
              {formatMoney(period[key] as string, currency)}
            </span>
          )}
        </td>
      ))}
    </tr>
  );
  const tree = (items: ProfitItem[]) => {
    const ids = new Set(items.map((item) => item.id));
    const children = new Map<string, ProfitItem[]>();
    for (const item of items)
      if (item.parent_id)
        children.set(item.parent_id, [
          ...(children.get(item.parent_id) ?? []),
          item,
        ]);
    const pending = items
      .filter((item) => !item.parent_id || !ids.has(item.parent_id))
      .map((item) => ({ item, depth: 0 }))
      .reverse();
    const rows = [];
    while (pending.length) {
      const { item, depth } = pending.pop()!;
      const hasChildren = children.has(item.id);
      rows.push(
        <tr key={item.id} data-subtotal={hasChildren || undefined}>
          <th scope="row">
            <div
              className="report-tree-name"
              style={{ paddingInlineStart: Math.min(depth, 4) * 12 }}
            >
              {hasChildren ? (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  aria-label={
                    (expanded.has(item.id) ? '收合' : '展開') + item.name
                  }
                  aria-expanded={expanded.has(item.id)}
                  onClick={() =>
                    setExpanded((old) => {
                      const next = new Set(old);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    })
                  }
                >
                  {expanded.has(item.id) ? '▾' : '▸'}
                </Button>
              ) : (
                <span className="report-leaf" />
              )}
              <span>{item.name}</span>
            </div>
          </th>
          {[...item.amounts, item.total].map((amount, index) => (
            <td key={index}>
              <span
                className={
                  hasChildren
                    ? 'report-money report-amount-main'
                    : 'report-money'
                }
              >
                {formatMoney(amount, currency)}
              </span>
            </td>
          ))}
        </tr>,
      );
      if (expanded.has(item.id))
        for (const child of [...(children.get(item.id) ?? [])].reverse())
          pending.push({ item: child, depth: depth + 1 });
    }
    return rows;
  };
  return (
    <section className="panel report-section">
      <EdgeScroll axis="x" label="損益表時段明細">
        <table className="report-table profit-table" aria-label="損益表明細">
          <thead>
            <tr>
              <th scope="col">科目</th>
              {columns.map((period, index) => (
                <th scope="col" key={index}>
                  {period.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.sections.map((section) => (
              <Fragment key={section.key}>
                {metric(section.key, sectionLabels[section.key])}
                {tree(section.items)}
                {section.key === 'operating_expense' && (
                  <>
                    {metric('fixed_expense', '其中固定性', 'reference')}
                    {metric('variable_expense', '其中變動', 'reference')}
                    {metric('operating_profit', '營業損益', 'profit')}
                  </>
                )}
                {section.key === 'non_operating_expense' &&
                  metric('non_operating_profit', '業外損益', 'profit')}
              </Fragment>
            ))}
            {metric('net_income', '本期損益', 'net')}
            {metric('operating_margin', '營業利益率', 'margin')}
          </tbody>
        </table>
      </EdgeScroll>
    </section>
  );
}
export function ProfitLoss({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    today = todayTaipei(),
    q = extendedFiltersFromLocation(location, today, true),
    args = new URLSearchParams(q as Record<string, string>).toString(),
    [draft, setDraft] = useState(q),
    {
      data: r,
      error,
      busy,
      retry,
    } = useReport<ProfitLossReport>(
      `/api/ledgers/${ledger.id}/reports/profit-loss?${args}`,
    ),
    mobile = useMediaQuery('(max-width: 899px)'),
    [period, setPeriod] = useState('total');
  useEffect(
    () => setDraft(extendedFiltersFromLocation(location, today, true)),
    [location, today],
  );
  useEffect(() => setPeriod('total'), [args]);
  const change = (k: string, v: string) => setDraft((s) => ({ ...s, [k]: v })),
    cols = r
      ? mobile
        ? [
            period === 'total'
              ? { label: '合計', index: -1, values: r.totals }
              : {
                  label: r.periods[Number(period)]?.label ?? '合計',
                  index: Number(period),
                  values: r.periods[Number(period)] ?? r.totals,
                },
          ]
        : [
            ...r.periods.map((p, index) => ({
              label: p.label,
              index,
              values: p,
            })),
            { label: '合計', index: -1, values: r.totals },
          ]
      : [];
  const summary = (key: keyof ProfitValues, label: string, ratio = false) => (
    <div className="profit-summary" key={key}>
      <h3>{label}</h3>
      <dl>
        {cols.map((c) => (
          <div key={c.label}>
            <dt>{c.label}</dt>
            <dd className="num">
              {ratio ? (
                formatPercent(c.values[key] as string | null)
              ) : [
                  'operating_profit',
                  'non_operating_profit',
                  'net_income',
                ].includes(key) ? (
                <Loss
                  value={c.values[key] as string}
                  currency={ledger.base_currency}
                />
              ) : (
                formatMoney(c.values[key] as string, ledger.base_currency)
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
  return (
    <Stack className="report-page profit-report">
      <h2>損益表</h2>
      <form
        className="panel report-form"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(
            extendedFiltersUrl('profit-loss', draft as Record<string, string>),
          );
          retry();
        }}
      >
        <div className="report-toolbar">
          <Dates draft={draft} change={change} />
          <Select
            label="損益表粒度"
            value={draft.grain}
            onChange={(v) => v && change('grain', v)}
            data={grainOptions.slice(1)}
          />
          <Button type="submit" disabled={busy}>
            產生損益表
          </Button>
        </div>
        <Text size="sm">每次最多 10 年；固定性／變動小計列於營業支出段。</Text>
      </form>
      {busy && <LoadingState label="損益表產生中" />}
      {error && <ErrorState message={error} retry={retry} />}
      {r && (
        <>
          <Text>產生時間：{generatedAt(r.generated_at)}</Text>
          <Export
            url={`/api/ledgers/${ledger.id}/reports/profit-loss.csv?${args}`}
          />
          {mobile && (
            <Select
              label="損益表時段"
              value={period}
              onChange={(v) => v && setPeriod(v)}
              data={[
                { value: 'total', label: '合計' },
                ...r.periods.map((p, i) => ({
                  value: String(i),
                  label: p.label,
                })),
              ]}
            />
          )}
          {!mobile ? (
            <ProfitLossTable
              key={args}
              report={r}
              currency={ledger.base_currency}
            />
          ) : (
            <>
              {r.sections.map((s, index) => (
                <section className="panel report-section" key={s.key}>
                  <h3>{sectionLabels[s.key]}</h3>
                  {summary(s.key, '區段合計')}
                  <EdgeScroll
                    axis="x"
                    label={sectionLabels[s.key] + '時段明細'}
                  >
                    <ReportTree
                      key={s.key + args}
                      defaultExpandRoots
                      rows={s.items}
                      columns={cols.map((c) => ({
                        label: c.label,
                        render: (i: ProfitItem) => (
                          <span className="report-money">
                            {formatMoney(
                              c.index < 0 ? i.total : i.amounts[c.index],
                              ledger.base_currency,
                            )}
                          </span>
                        ),
                      }))}
                    />
                  </EdgeScroll>
                  {index === 1 && (
                    <>
                      {summary('fixed_expense', '其中固定性')}
                      {summary('variable_expense', '其中變動')}
                      {summary('operating_profit', '營業損益')}
                    </>
                  )}
                  {index === 3 && summary('non_operating_profit', '業外損益')}
                </section>
              ))}
              <section className="panel report-section">
                {summary('net_income', '本期損益')}
                {summary('operating_margin', '營業利益率', true)}
              </section>
            </>
          )}
        </>
      )}
    </Stack>
  );
}
export function FlowReports({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    view = flowViewFromLocation(location);
  return (
    <Stack>
      <h2>流量</h2>
      <SegmentedControl
        aria-label="流量子檢視"
        className="flow-views"
        value={view}
        onChange={(v) =>
          navigate(
            extendedFiltersUrl(
              'flow',
              v === 'cash-forecast'
                ? forecastFiltersFromLocation(location)
                : v === 'account-ledger'
                  ? accountFiltersFromLocation(location, todayTaipei())
                  : (extendedFiltersFromLocation(
                      location,
                      todayTaipei(),
                    ) as Record<string, string>),
              v,
            ),
          )
        }
        data={[
          { value: 'net-worth-flow', label: '淨值流量' },
          { value: 'account-ledger', label: '帳戶異動明細' },
          { value: 'cash-forecast', label: '資金預估' },
        ]}
      />
      {view === 'cash-forecast' ? (
        <CashForecast key={ledger.id} ledger={ledger} />
      ) : view === 'account-ledger' ? (
        <AccountLedger key={ledger.id} ledger={ledger} />
      ) : (
        <NetWorthFlow ledger={ledger} />
      )}
    </Stack>
  );
}
const flowLabels = [
  ['期初淨值', 'opening'],
  ['收入', 'income'],
  ['支出', 'expense'],
  ['權益變動', 'equity_change'],
  ['期末淨值', 'closing'],
] as const;
function NetWorthFlow({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    today = todayTaipei(),
    q = extendedFiltersFromLocation(location, today),
    [draft, setDraft] = useState(q),
    args = new URLSearchParams(q as Record<string, string>).toString(),
    {
      data: r,
      error,
      busy,
      retry,
    } = useReport<NetWorthFlowReport>(
      `/api/ledgers/${ledger.id}/reports/net-worth-flow?${args}`,
    ),
    mobile = useMediaQuery('(max-width: 899px)');
  useEffect(
    () => setDraft(extendedFiltersFromLocation(location, today)),
    [location, today],
  );
  const change = (k: string, v: string) => setDraft((s) => ({ ...s, [k]: v }));
  return (
    <Stack className="report-page">
      <h3>淨值流量</h3>
      <form
        className="panel report-form"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(extendedFiltersUrl('flow', draft as Record<string, string>));
          retry();
        }}
      >
        <div className="report-toolbar">
          <Dates draft={draft} change={change} />
          <Select
            label="淨值流量粒度"
            value={draft.grain}
            onChange={(v) => v && change('grain', v)}
            data={grainOptions}
          />
          <Button type="submit" disabled={busy}>
            產生淨值流量
          </Button>
        </div>
        <Text size="sm">每次最多 1,000 個時段。</Text>
      </form>
      {busy && <LoadingState label="淨值流量產生中" />}
      {error && <ErrorState message={error} retry={retry} />}
      {r && (
        <>
          <Text>產生時間：{generatedAt(r.generated_at)}</Text>
          {r.periods.some((p) => !p.is_balanced) && (
            <div className="report-warning" role="alert">
              淨值恆等式不相符，請檢查分錄。
              {r.periods
                .filter((p) => !p.is_balanced)
                .map((p) => (
                  <p key={p.label}>
                    {p.label} 差額{' '}
                    {formatMoney(p.identity_difference, ledger.base_currency)}
                  </p>
                ))}
            </div>
          )}
          <Export
            url={`/api/ledgers/${ledger.id}/reports/net-worth-flow.csv?${args}`}
          />
          <Suspense fallback={<LoadingState label="圖表載入中" />}>
            <FlowChart report={r} />
          </Suspense>
          <section className="panel report-section">
            {mobile ? (
              <div className="report-cards">
                {r.periods.map((p) => (
                  <article className="report-card" key={p.bucket_start}>
                    <h4>{p.label}</h4>
                    <dl>
                      {flowLabels.map(([label, key]) => (
                        <div key={key}>
                          <dt>{label}</dt>
                          <dd className="report-money">
                            {formatMoney(p[key], ledger.base_currency)}
                          </dd>
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
                    <th>時段</th>
                    {flowLabels.map(([label]) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.periods.map((p) => (
                    <tr key={p.bucket_start}>
                      <th>{p.label}</th>
                      {flowLabels.map(([, k]) => (
                        <td className="report-money" key={k}>
                          {formatMoney(p[k], ledger.base_currency)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <details className="panel report-note">
            <summary>計算說明</summary>
            <p>
              期初＋收入−支出＋權益變動＝期末；使用歷史帳面值，轉帳不改變淨值。
            </p>
          </details>
        </>
      )}
    </Stack>
  );
}
function AccountLedger({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    today = todayTaipei(),
    q = accountFiltersFromLocation(location, today),
    [draft, setDraft] = useState(q),
    args = new URLSearchParams(q).toString(),
    {
      data: r,
      error,
      busy,
      retry,
    } = useReport<AccountLedgerReport>(
      q.item_id
        ? `/api/ledgers/${ledger.id}/reports/account-ledger?${args}`
        : null,
    ),
    {
      data: items,
      error: itemError,
      retry: itemRetry,
    } = useReport<Item[]>(
      `/api/ledgers/${ledger.id}/items?include_archived=true`,
    ),
    [rows, setRows] = useState<AccountLedgerReport['items']>([]),
    [next, setNext] = useState<string | null>(null),
    [moreError, setMoreError] = useState(''),
    [loadingMore, setLoadingMore] = useState(false),
    mobile = useMediaQuery('(max-width: 899px)');
  useEffect(
    () => setDraft(accountFiltersFromLocation(location, today)),
    [location, today],
  );
  useEffect(() => {
    setRows(r?.items ?? []);
    setNext(r?.next_cursor ?? null);
    setMoreError('');
  }, [r]);
  const change = (k: string, v: string) => setDraft((s) => ({ ...s, [k]: v }));
  const base = `/api/ledgers/${ledger.id}/reports/account-ledger`;
  return (
    <Stack className="report-page">
      <h3>帳戶異動明細</h3>
      {itemError && <ErrorState message={itemError} retry={itemRetry} />}
      <form
        className="panel report-form"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(extendedFiltersUrl('flow', draft, 'account-ledger'));
          retry();
        }}
      >
        <div className="report-toolbar">
          <ItemPicker
            items={items ?? []}
            mode="filter"
            required
            searchable
            label="異動科目（含子科目）"
            value={draft.item_id}
            onChange={(v) => v && change('item_id', v)}
            data={(items ?? [])
              .filter((i) => ['asset', 'liability'].includes(i.kind))
              .map((i) => ({
                value: i.id,
                label: i.name + (i.archived ? '（已封存）' : ''),
              }))}
          />
          <Dates draft={draft} change={change} />
          <Button type="submit" disabled={busy || !draft.item_id}>
            查詢帳戶異動
          </Button>
        </div>
      </form>
      {busy && <LoadingState label="帳戶異動載入中" />}
      {error && <ErrorState message={error} retry={retry} />}
      {!q.item_id && (
        <EmptyState title="請選擇資產或負債科目">
          包含所有子科目，原幣與本位幣依幣別各自累計。
        </EmptyState>
      )}
      {r && (
        <>
          <Text>
            產生時間：{generatedAt(r.generated_at)}
            ；流入／流出及餘額採科目自然方向。
          </Text>
          <div className="report-cards">
            {r.balances.map((b) => (
              <section className="panel report-card" key={b.currency}>
                <h4>{b.currency} 餘額</h4>
                <dl>
                  <div>
                    <dt>期初原幣</dt>
                    <dd>{formatMoney(b.opening_original, b.currency)}</dd>
                  </div>
                  <div>
                    <dt>期初本位幣</dt>
                    <dd>{formatMoney(b.opening_book, ledger.base_currency)}</dd>
                  </div>
                  <div>
                    <dt>期末原幣</dt>
                    <dd>{formatMoney(b.closing_original, b.currency)}</dd>
                  </div>
                  <div>
                    <dt>期末本位幣</dt>
                    <dd>{formatMoney(b.closing_book, ledger.base_currency)}</dd>
                  </div>
                </dl>
              </section>
            ))}
          </div>
          <Export url={base + '.csv?' + args} label="匯出帳戶異動 CSV" />
          {!rows.length ? (
            <EmptyState title="這段期間沒有分錄">
              可調整日期；期初與期末餘額仍列於上方。
            </EmptyState>
          ) : mobile ? (
            <div className="report-cards">
              {rows.map((i) => (
                <article className="report-card account-entry" key={i.entry_id}>
                  <Button
                    variant="subtle"
                    onClick={() => openEntry(i.transaction_id)}
                  >
                    {formatDate(i.occurred_on)} · 修改交易
                  </Button>
                  <h4>
                    {i.item_name} · {i.counterpart}
                  </h4>
                  <p>{i.memo || '無摘要'}</p>
                  <dl>
                    {[
                      ['流入', formatMoney(i.inflow, ledger.base_currency)],
                      ['流出', formatMoney(i.outflow, ledger.base_currency)],
                      ['原幣', formatMoney(i.amount, i.currency)],
                      ['匯率', formatRate(i.exchange_rate)],
                      [
                        '本位幣',
                        formatMoney(i.base_amount, ledger.base_currency),
                      ],
                      ['原幣累計', formatMoney(i.original_balance, i.currency)],
                      [
                        '本位幣累計',
                        formatMoney(i.book_balance, ledger.base_currency),
                      ],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd
                          className="report-money"
                          title={k === '匯率' ? i.exchange_rate : undefined}
                        >
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
          ) : (
            <EdgeScroll axis="x" label="帳戶異動分錄">
              <table className="report-table account-table">
                <thead>
                  <tr>
                    {[
                      '日期',
                      '摘要／對方科目',
                      '流入',
                      '流出',
                      '原幣',
                      '匯率',
                      '本位幣',
                      '原幣累計',
                      '本位幣累計',
                    ].map((k) => (
                      <th key={k}>{k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.entry_id}>
                      <th>
                        <Button
                          variant="subtle"
                          onClick={() => openEntry(i.transaction_id)}
                        >
                          {formatDate(i.occurred_on)}
                        </Button>
                      </th>
                      <td>
                        {i.memo || '無摘要'}
                        <br />
                        {i.item_name} · {i.counterpart}
                      </td>
                      {[
                        formatMoney(i.inflow, ledger.base_currency),
                        formatMoney(i.outflow, ledger.base_currency),
                        formatMoney(i.amount, i.currency),
                        formatRate(i.exchange_rate),
                        formatMoney(i.base_amount, ledger.base_currency),
                        formatMoney(i.original_balance, i.currency),
                        formatMoney(i.book_balance, ledger.base_currency),
                      ].map((v, index) => (
                        <td
                          className="report-money"
                          title={index === 3 ? i.exchange_rate : undefined}
                          key={index}
                        >
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </EdgeScroll>
          )}
          {moreError && <ErrorState message={moreError} />}
          {next && (
            <Button
              disabled={loadingMore}
              onClick={() => {
                setLoadingMore(true);
                setMoreError('');
                const requestedArgs = args;
                void api<AccountLedgerReport>(
                  base + '?' + args + '&cursor=' + encodeURIComponent(next),
                )
                  .then((p) => {
                    if (
                      accountFiltersFromLocation(
                        window.location.pathname + window.location.search,
                        today,
                      ).item_id !== q.item_id ||
                      new URLSearchParams(
                        accountFiltersFromLocation(
                          window.location.pathname + window.location.search,
                          today,
                        ),
                      ).toString() !== requestedArgs
                    )
                      return;
                    setRows((old) => [...old, ...p.items]);
                    setNext(p.next_cursor);
                  })
                  .catch((e) => setMoreError(errorMessage(e)))
                  .finally(() => setLoadingMore(false));
              }}
            >
              載入更多分錄
            </Button>
          )}
        </>
      )}
    </Stack>
  );
}
