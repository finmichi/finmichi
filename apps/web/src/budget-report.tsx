// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, lazy, Suspense } from 'react';
import { Button, Select, Stack, Text, TextInput } from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import type { BudgetReport } from '@finmichi/core/report-schemas';
import { api, errorMessage } from './api';
import { LoadingState, ErrorState } from './design/feedback';
import { useLocation, navigate } from './design/location';
import {
  budgetFiltersFromLocation,
  budgetFiltersUrl,
  budgetPeriodFromLocation,
} from './design/report-state';
import { useTransactionRevision } from './design/data-revision';
import { formatMoney, formatPercent } from './design/format';
import {
  todayTaipei,
  generatedAt,
  downloadReport,
  ReportTree,
} from './report-common';
const Charts = lazy(() => import('./budget-charts'));
export function BudgetVsActual({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    today = todayTaipei(),
    q = budgetFiltersFromLocation(location, today),
    [draft, setDraft] = useState(q),
    [report, setReport] = useState<BudgetReport | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    period = budgetPeriodFromLocation(location, q, today),
    [exporting, setExporting] = useState(false);
  const txRevision = useTransactionRevision(),
    base = `/api/ledgers/${ledger.id}/reports/budget-vs-actual`,
    args = new URLSearchParams(q).toString();
  useEffect(
    () => setDraft(budgetFiltersFromLocation(location, today)),
    [location, today],
  );
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    void api<BudgetReport>(base + '?' + args)
      .then((r) => {
        if (live) {
          setReport(r);
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
  }, [base, args, revision, txRevision]);
  useEffect(() => {
    if (new URLSearchParams(location.split('?')[1]).get('period') !== period)
      navigate(budgetFiltersUrl(q) + '&period=' + period, true);
  }, [location, period, q.year, q.grain, q.kind, q.non_operating, q.fixed]);
  const current = report?.periods.find((p) => p.bucket_start === period);
  const change = (k: keyof typeof draft, v: string | null) => {
    if (v !== null) setDraft((s) => ({ ...s, [k]: v }));
  };
  return (
    <Stack className="report-page">
      <h2>預算 vs 實際</h2>
      {error && (
        <ErrorState message={error} retry={() => setRevision((v) => v + 1)} />
      )}
      <form
        className="panel report-form"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(
            budgetFiltersUrl(draft) +
              '&period=' +
              budgetPeriodFromLocation('', draft, today),
          );
          setRevision((v) => v + 1);
        }}
      >
        <div className="report-toolbar">
          <TextInput
            label="報表年度"
            value={draft.year}
            inputMode="numeric"
            onChange={(e) => change('year', e.currentTarget.value)}
          />
          <Select
            label="預算報表粒度"
            value={draft.grain}
            onChange={(v) => change('grain', v)}
            data={[
              { value: 'month', label: '月' },
              { value: 'quarter', label: '季' },
              { value: 'year', label: '年' },
            ]}
          />
          <Select
            label="預算報表類別"
            value={draft.kind}
            onChange={(v) => change('kind', v)}
            data={[
              { value: 'expense', label: '支出' },
              { value: 'income', label: '收入' },
            ]}
          />
          <Select
            label="業外篩選"
            value={draft.non_operating}
            onChange={(v) => change('non_operating', v)}
            data={[
              { value: 'all', label: '全部' },
              { value: 'operating', label: '僅營業' },
              { value: 'non_operating', label: '僅業外' },
            ]}
          />
          <Select
            label="固定性篩選"
            value={draft.fixed}
            onChange={(v) => change('fixed', v)}
            data={[
              { value: 'all', label: '全部' },
              { value: 'fixed', label: '僅固定' },
              { value: 'variable', label: '僅非固定' },
            ]}
          />
          <Button type="submit" disabled={busy}>
            產生預算報表
          </Button>
        </div>
      </form>
      <Button
        variant="default"
        disabled={
          !report ||
          !!error ||
          busy ||
          exporting ||
          JSON.stringify(draft) !== JSON.stringify(q)
        }
        onClick={() => {
          setExporting(true);
          void downloadReport(base + '.csv?' + args, 'budget-vs-actual.csv')
            .catch((e) => setError(errorMessage(e)))
            .finally(() => setExporting(false));
        }}
      >
        匯出預算報表 CSV
      </Button>
      {busy && <LoadingState label="報表產生中" hasData={!!report} />}{' '}
      {report && (
        <>
          <Text>
            年度 {report.year}；產生時間：{generatedAt(report.generated_at)}
          </Text>
          <div className="kpi-grid">
            {[
              ['全年預算', report.totals.budget_total],
              ['全年實際', report.totals.actual_total],
              ['全年差異', report.totals.variance],
              ['全年達成率', report.totals.achievement],
            ].map(([label, v]) => (
              <section className="panel budget-kpi" key={label}>
                <h3>{label}</h3>
                <strong className="num">
                  {label === '全年達成率'
                    ? formatPercent(v)
                    : formatMoney(v, ledger.base_currency)}
                </strong>
              </section>
            ))}
          </div>
          <details className="panel report-note">
            <summary>計算說明</summary>
            <p>
              差異＝實際−預算；達成率＝實際÷預算。零預算達成率不適用。各科目小計含子孫；全年合計只加自身金額，不重複加小計。篩選依各科目自身旗標。
            </p>
          </details>
          <Suspense fallback={<LoadingState label="圖表載入中" />}>
            <Charts report={report} />
          </Suspense>
          <Select
            label="報表時段"
            value={period}
            onChange={(v) => {
              if (v) navigate(budgetFiltersUrl(q) + '&period=' + v);
            }}
            data={report.periods.map((p) => ({
              value: p.bucket_start,
              label: p.label,
            }))}
          />
          {current && (
            <section className="panel report-section">
              <div className="panel-heading">
                <h3>{current.label} 科目預算明細</h3>
              </div>
              <ReportTree
                key={current.bucket_start + args}
                defaultExpandRoots
                rows={current.items}
                columns={[
                  {
                    label: '預算',
                    render: (i) => (
                      <span
                        className="report-money"
                        title={
                          '自身 ' +
                          formatMoney(i.budget_own, ledger.base_currency)
                        }
                      >
                        {formatMoney(i.budget_rollup, ledger.base_currency)}
                      </span>
                    ),
                  },
                  {
                    label: '實際',
                    render: (i) => (
                      <span className="report-money">
                        {formatMoney(i.actual_rollup, ledger.base_currency)}
                      </span>
                    ),
                  },
                  {
                    label: '差異',
                    render: (i) => (
                      <span
                        className={
                          report.kind === 'expense' &&
                          !i.variance.startsWith('-') &&
                          !/^0(?:\.0+)?$/.test(i.variance)
                            ? 'budget-over'
                            : ''
                        }
                      >
                        <span className="report-money">
                          {formatMoney(i.variance, ledger.base_currency)}
                        </span>
                        {report.kind === 'expense' &&
                          !i.variance.startsWith('-') &&
                          !/^0(?:\.0+)?$/.test(i.variance) && (
                            <strong> 超支</strong>
                          )}
                      </span>
                    ),
                  },
                  {
                    label: '達成率',
                    render: (i) => (
                      <span className="num">
                        {i.achievement === null
                          ? '不適用（零預算）'
                          : formatPercent(i.achievement)}
                      </span>
                    ),
                  },
                ]}
              />
            </section>
          )}
        </>
      )}
    </Stack>
  );
}
