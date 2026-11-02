// SPDX-License-Identifier: AGPL-3.0-only
import { ProjectFilter } from './project-filter';
import { LoadingState, ErrorState } from './design/feedback';
import { useLocation, navigate } from './design/location';
import {
  incomeFiltersFromLocation,
  incomeFiltersUrl,
} from './design/report-state';
import { useEffect, useState, lazy, Suspense } from 'react';
import {
  Button,
  Stack,
  Text,
  TextInput,
  Title,
  Skeleton,
  Select,
} from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import type { IncomeReport, IncomeValues } from '@finmichi/core/report-schemas';
import { formatMoney } from './design/format';
import { useMediaQuery } from '@mantine/hooks';
import { useTransactionRevision } from './design/data-revision';
const IncomeChart = lazy(() =>
  import('./report-charts').then((m) => ({ default: m.IncomeChart })),
);
import { api, errorMessage } from './api';
import { generatedAt, todayTaipei, downloadReport } from './report-common';
const labels = [
  ['營業收入', 'operating_income'],
  ['業外收入', 'non_operating_income'],
  ['營業支出', 'operating_expense'],
  ['業外支出', 'non_operating_expense'],
  ['收入合計', 'income_total'],
  ['支出合計', 'expense_total'],
  ['淨收支', 'net_income'],
] as const;
export function IncomeSummary({ ledger }: { ledger: Ledger }) {
  const mobile = useMediaQuery('(max-width: 899px)');
  const transactionRevision = useTransactionRevision();
  const location = useLocation();
  const today = todayTaipei();
  const applied = incomeFiltersFromLocation(location, today);
  const [draft, setDraft] = useState(() => applied),
    [report, setReport] = useState<IncomeReport | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false);
  useEffect(() => {
    setDraft(incomeFiltersFromLocation(location, today));
  }, [location, today]);
  const path = `/api/ledgers/${ledger.id}/reports/income-summary`,
    args = new URLSearchParams(applied).toString();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    void api<IncomeReport>(path + '?' + args)
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
  const values = (v: IncomeValues) => (
    <dl className="income-values">
      {labels.map(([label, key]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd
            className={
              'num ' +
              (key.includes('expense')
                ? 'expense'
                : key.includes('income') && key !== 'net_income'
                  ? 'income'
                  : '')
            }
          >
            {formatMoney(v[key], ledger.base_currency, { compact: mobile })}
          </dd>
        </div>
      ))}
    </dl>
  );
  return (
    <Stack className="report-page">
      <Title order={2}>收支彙總</Title>
      {error && (
        <ErrorState message={error} retry={() => setRevision((v) => v + 1)} />
      )}
      <form
        className="panel report-form"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(incomeFiltersUrl(draft));
          setRevision((v) => v + 1);
        }}
      >
        <div className="report-toolbar">
          <ProjectFilter
            ledger={ledger.id}
            label="收支專案"
            value={draft.project_id}
            onChange={(project_id) =>
              setDraft((old) => {
                const next = { ...old };
                if (project_id) next.project_id = project_id;
                else delete next.project_id;
                return next;
              })
            }
          />
          <TextInput
            type="date"
            label="收支起始日期"
            value={draft.date_from}
            onChange={(e) =>
              setDraft({ ...draft, date_from: e.currentTarget.value })
            }
          />
          <TextInput
            type="date"
            label="收支結束日期"
            value={draft.date_to}
            onChange={(e) =>
              setDraft({ ...draft, date_to: e.currentTarget.value })
            }
          />
          <Select
            label="收支粒度"
            value={draft.grain}
            onChange={(v) => {
              if (v) setDraft({ ...draft, grain: v });
            }}
            data={[
              { value: 'day', label: '日' },
              { value: 'month', label: '月' },
              { value: 'quarter', label: '季' },
              { value: 'year', label: '年' },
            ]}
          />
          <Button type="submit" disabled={busy}>
            產生收支彙總
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
          void downloadReport(path + '.csv?' + args, 'income-summary.csv')
            .catch((e) => setError(errorMessage(e)))
            .finally(() => setExporting(false));
        }}
      >
        匯出收支彙總 CSV
      </Button>
      {busy && <LoadingState label="報表產生中" hasData={report !== null} />}
      {report && (
        <>
          <Text>
            期間：{report.date_from}～{report.date_to}；產生時間：
            {generatedAt(report.generated_at)}
          </Text>
          <details className="panel report-note">
            <summary>計算說明</summary>{' '}
            <Text size="sm" role="note">
              {
                (
                  {
                    day: '日：最多 1,000 天',
                    month: '月：最多 1,000 個月份（約 83 年）',
                    quarter: '季：最多 1,000 季（約 250 年）',
                    year: '年：最多 1,000 年',
                  } as Record<string, string>
                )[draft.grain]
              }
              。起訖所跨的每個時段都計入，包含無交易的時段。
            </Text>
            <p>
              依收入／支出分錄計算，營業與業外依各科目自身旗標。轉帳及權益不影響收支，無交易時段補0。
            </p>
          </details>
          <section className="panel report-section" data-testid="income-totals">
            <div className="panel-heading">
              <h3>期間合計</h3>
            </div>
            {values(report.totals)}
          </section>
          <section className="panel report-section">
            <div className="panel-heading">
              <h3>期間收支趨勢</h3>
            </div>
            <Suspense fallback={<Skeleton height={300} />}>
              <IncomeChart report={report} />
            </Suspense>
          </section>
          {mobile ? (
            <div className="report-cards">
              {report.periods.map((b) => (
                <article
                  className="panel report-card"
                  key={b.bucket_start}
                  data-testid="income-period"
                >
                  <h3>{b.label}</h3>
                  <Text size="sm" c="dimmed">
                    {b.date_from}～{b.date_to}
                  </Text>
                  {values(b)}
                </article>
              ))}
            </div>
          ) : (
            <section className="panel report-section">
              <table className="report-table income-table">
                <thead>
                  <tr>
                    <th scope="col">時段</th>
                    {labels.map(([label, key]) => (
                      <th scope="col" key={key}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.periods.map((b) => (
                    <tr key={b.bucket_start} data-testid="income-period">
                      <th scope="row">
                        <h3>{b.label}</h3>
                      </th>
                      {labels.map(([, key]) => (
                        <td className="num" key={key}>
                          {formatMoney(b[key], ledger.base_currency)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">合計</th>
                    {labels.map(([, key]) => (
                      <td className="num" key={key}>
                        {formatMoney(report.totals[key], ledger.base_currency)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </section>
          )}
        </>
      )}
    </Stack>
  );
}
