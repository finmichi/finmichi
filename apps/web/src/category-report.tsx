// SPDX-License-Identifier: AGPL-3.0-only
import { LoadingState, ErrorState } from './design/feedback';
import { useLocation, navigate } from './design/location';
import {
  categoryFiltersFromLocation,
  categoryFiltersUrl,
} from './design/report-state';
import { useEffect, useState, lazy, Suspense } from 'react';
import {
  Alert,
  Button,
  Stack,
  Text,
  TextInput,
  Title,
  Select,
} from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import type { CategoryReport } from '@finmichi/core/report-schemas';
import { formatMoney, formatPercent } from './design/format';
import { useTransactionRevision } from './design/data-revision';
import { api, errorMessage } from './api';
import {
  generatedAt,
  todayTaipei,
  downloadReport,
  ReportTree,
} from './report-common';
const ReportCharts = lazy(() => import('./report-charts'));
export function CategoryStatistics({ ledger }: { ledger: Ledger }) {
  const transactionRevision = useTransactionRevision();
  const location = useLocation();
  const today = todayTaipei();
  const applied = categoryFiltersFromLocation(location, today);
  const [draft, setDraft] = useState(() => applied),
    [report, setReport] = useState<CategoryReport | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false);
  useEffect(() => {
    setDraft(categoryFiltersFromLocation(location, today));
  }, [location, today]);
  const path = `/api/ledgers/${ledger.id}/reports/category-statistics`,
    args = new URLSearchParams(applied).toString();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    void api<CategoryReport>(path + '?' + args)
      .then((r) => {
        if (live) setReport(r);
      })
      .catch((e) => {
        if (live) {
          setError(errorMessage(e));
        }
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [path, args, revision, transactionRevision]);
  const change = (key: keyof typeof draft, value: string | null) => {
    if (value !== null) setDraft((old) => ({ ...old, [key]: value }));
  };
  const reason =
    report?.pie_reason === 'negative_total'
      ? '不適用（總額為負）'
      : report?.pie_reason === 'zero_total'
        ? '不適用（總額為 0）'
        : report?.pie_reason === 'negative_items'
          ? '含負值，請參考長條圖與明細'
          : '';
  const notApplicable = report?.total_amount.startsWith('-')
    ? '不適用（總額為負）'
    : '不適用（總額為 0）';
  return (
    <Stack className="report-page" style={{ minWidth: 0 }}>
      <Title order={2}>分類統計</Title>
      {error && (
        <ErrorState message={error} retry={() => setRevision((v) => v + 1)} />
      )}
      <form
        className="panel report-form"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(categoryFiltersUrl(draft));
          setRevision((v) => v + 1);
        }}
      >
        <div className="report-toolbar">
          <TextInput
            type="date"
            label="分類起始日期"
            value={draft.date_from}
            onChange={(e) => change('date_from', e.currentTarget.value)}
          />
          <TextInput
            type="date"
            label="分類結束日期"
            value={draft.date_to}
            onChange={(e) => change('date_to', e.currentTarget.value)}
          />
          <Select
            label="分類類別"
            value={draft.kind}
            onChange={(v) => change('kind', v)}
            data={[
              { value: 'income', label: '收入' },
              { value: 'expense', label: '支出' },
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
            產生分類統計
          </Button>
        </div>
      </form>
      <Button
        className="report-export"
        variant="default"
        disabled={
          !report ||
          !!error ||
          busy ||
          exporting ||
          JSON.stringify(draft) !== JSON.stringify(applied)
        }
        onClick={() => {
          setExporting(true);
          void downloadReport(path + '.csv?' + args, 'category-statistics.csv')
            .catch((e) => setError(errorMessage(e)))
            .finally(() => setExporting(false));
        }}
      >
        匯出分類統計 CSV
      </Button>
      {busy && <LoadingState label="報表產生中" hasData={report !== null} />}
      {report && (
        <>
          <Text>
            期間：{report.date_from}～{report.date_to}；產生時間：
            {generatedAt(report.generated_at)}
          </Text>
          <Text fw={600}>
            期間總額：{formatMoney(report.total_amount, ledger.base_currency)}
          </Text>
          <Text>
            第一層合計驗算：{report.root_total_matches ? '通過' : '不平衡'}
          </Text>
          <details className="panel report-note">
            <summary>計算說明</summary>
            <p>
              篩選依分錄科目自身旗標，祖先只提供階層與小計；自身與子樹金額不可重複相加。占比各自四捨五入，畫面合計可能略有差異。
            </p>
          </details>
          {reason && (
            <Alert role="status" color="yellow">
              {reason}
            </Alert>
          )}
          <div className="report-category-grid">
            <Suspense fallback={<Text>圖表載入中…</Text>}>
              <ReportCharts report={report} />
            </Suspense>
            <section className="panel report-section">
              <div className="panel-heading">
                <h3>科目分類明細</h3>
              </div>
              <ReportTree
                rows={report.items}
                columns={[
                  {
                    label: '金額',
                    render: (i, mobile) => (
                      <div className="report-amount">
                        <strong className="report-money">
                          {formatMoney(i.rollup_amount, ledger.base_currency, {
                            compact: mobile,
                          })}
                        </strong>
                        {!i.is_leaf && (
                          <small className="report-money">
                            自身{' '}
                            {formatMoney(i.own_amount, ledger.base_currency, {
                              compact: mobile,
                            })}
                          </small>
                        )}
                      </div>
                    ),
                  },
                  {
                    label: '占比',
                    render: (i) => (
                      <span className="num">
                        {i.percentage === null
                          ? notApplicable
                          : formatPercent(i.percentage)}
                      </span>
                    ),
                  },
                  {
                    label: '屬性',
                    render: (i) => (
                      <span>
                        {i.non_operating ? '業外' : '營業'}／
                        {i.fixed ? '固定' : '非固定'}
                        {i.archived ? '／已封存' : ''}
                      </span>
                    ),
                  },
                ]}
              />
            </section>
          </div>
        </>
      )}
    </Stack>
  );
}
