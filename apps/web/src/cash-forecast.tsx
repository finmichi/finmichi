// SPDX-License-Identifier: AGPL-3.0-only
import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Button,
  MultiSelect,
  Select,
  Stack,
  TextInput,
  Text,
} from '@mantine/core';
import type { Ledger, Item } from '@finmichi/core/catalog-schemas';
import type { CashForecastReport } from '@finmichi/core/cash-forecast-schemas';
import { useReport } from './report-hooks';
import { LoadingState, ErrorState, EmptyState } from './design/feedback';
import { useLocation, navigate } from './design/location';
import {
  forecastFiltersFromLocation,
  extendedFiltersUrl,
} from './design/report-state';
import { formatMoney } from './design/format';
import { generatedAt } from './report-common';
const Chart = lazy(() => import('./forecast-chart'));
const labels = {
  transaction: '已記帳的未來交易',
  occurrence: '週期待確認',
  recurring: '週期規則',
  card: '信用卡',
  loan: '貸款',
  deposit: '定存',
};
export default function CashForecast({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    q = forecastFiltersFromLocation(location),
    [draft, setDraft] = useState(q),
    args = new URLSearchParams(q).toString(),
    {
      data: r,
      error,
      busy,
      retry,
    } = useReport<CashForecastReport>(
      `/api/ledgers/${ledger.id}/reports/cash-forecast?${args}`,
    ),
    {
      data: items,
      error: itemError,
      retry: itemRetry,
    } = useReport<Item[]>(`/api/ledgers/${ledger.id}/items`);
  useEffect(() => setDraft(forecastFiltersFromLocation(location)), [location]);
  const options = (items ?? [])
    .filter(
      (i) =>
        i.kind === 'asset' &&
        !i.archived &&
        !i.loan &&
        i.currency === ledger.base_currency,
    )
    .map((i) => ({ value: i.id, label: i.name }));
  for (const id of draft.accounts?.split(',') ?? [])
    if (!options.some((o) => o.value === id))
      options.push({
        value: id,
        label: items ? '無法使用的帳戶' : '帳戶載入中',
      });
  return (
    <Stack className="report-page cash-forecast">
      <h3>資金預估</h3>
      <Text size="sm">
        只預估本位幣帳戶，不做匯率預測；本報表只試算，不會建立交易。
      </Text>
      <form
        className="panel report-form"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(extendedFiltersUrl('flow', draft, 'cash-forecast'));
          retry();
        }}
      >
        <div className="report-toolbar">
          <MultiSelect
            label="預估帳戶"
            placeholder="預設全部符合條件的帳戶"
            searchable
            clearable
            value={draft.accounts ? draft.accounts.split(',') : []}
            onChange={(v) => setDraft((s) => ({ ...s, accounts: v.join(',') }))}
            data={options}
          />
          <Select
            label="預估天數"
            value={draft.horizon_days}
            onChange={(v) => v && setDraft((s) => ({ ...s, horizon_days: v }))}
            data={['30', '60', '90', '180', '366'].map((v) => ({
              value: v,
              label: v + ' 天（含今天）',
            }))}
          />
          <TextInput
            label="資金門檻"
            aria-label="資金門檻"
            inputMode="decimal"
            value={draft.threshold}
            onChange={(e) =>
              setDraft((s) => ({ ...s, threshold: e.target.value }))
            }
            pattern="-?[0-9]+([.][0-9]{1,2})?"
            required
          />
          <Button type="submit" disabled={busy}>
            產生資金預估
          </Button>
        </div>
      </form>
      {busy && <LoadingState label="資金預估產生中" />}
      {error && <ErrorState message={error} retry={retry} />}
      {itemError && <ErrorState message={itemError} retry={itemRetry} />}
      {r && (
        <>
          <Text size="sm">
            產生時間：{generatedAt(r.generated_at)}；{r.as_of} 至 {r.date_to}
            ，每日顯示日終餘額。
          </Text>
          <div className="report-cards forecast-kpis">
            <section className="panel report-card">
              <h4>今日起始餘額</h4>
              <p className="report-money">
                {formatMoney(r.opening_total, ledger.base_currency)}
              </p>
            </section>
            <section className="panel report-card">
              <h4>預估期末餘額</h4>
              <p className="report-money">
                {formatMoney(r.days.at(-1)?.total, ledger.base_currency)}
              </p>
            </section>
          </div>
          {r.first_below_threshold ? (
            <div className="report-warning" role="alert">
              預估 {r.first_below_threshold} 資金低於{' '}
              {formatMoney(r.threshold, ledger.base_currency)}
            </div>
          ) : (
            <Text>預估期間日終合計未低於門檻。</Text>
          )}
          {!r.accounts.length ? (
            <EmptyState title="沒有可預估的本位幣帳戶">
              請建立未封存、非貸款的本位幣資產科目。
            </EmptyState>
          ) : (
            <Suspense fallback={<LoadingState label="預估圖表載入中" />}>
              <Chart report={r} />
            </Suspense>
          )}
          <Text size="sm">
            繳卡費週期規則可能與卡片預估重複。若已用週期規則記錄繳款，請將該規則排除或停用以免重複。
          </Text>
          <section className="panel report-section">
            {r.warnings.map((w) => (
              <p className="finance-warning" key={w.item_id}>
                信用卡缺少預估匯率，相關繳款未計入。請至信用卡與匯率設定確認。
              </p>
            ))}
            <h4>預估事件（{r.events.length} 筆）</h4>
            {!r.events.length ? (
              <EmptyState title="這段期間沒有預估事件">
                餘額維持起點金額，未來刷卡不在預估範圍內。
              </EmptyState>
            ) : (
              <div className="report-cards">
                {r.events.map((e, i) => (
                  <article
                    className="report-card"
                    key={`${e.source_type}:${e.source_id}:${e.account_id}:${i}`}
                  >
                    <h4>
                      {e.date} · {labels[e.source_type]}
                    </h4>
                    <p>{e.memo || '無摘要'}</p>
                    <dl>
                      <div>
                        <dt>帳戶</dt>
                        <dd>
                          {r.accounts.find((a) => a.id === e.account_id)?.name}
                        </dd>
                      </div>
                      <div>
                        <dt>流量</dt>
                        <dd className="report-money">
                          {formatMoney(e.amount, ledger.base_currency)}
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            )}
          </section>
          <details className="panel report-note">
            <summary>計算說明</summary>
            <p>
              起點包含今日已記帳餘額。未來已記帳交易、週期待確認項目與規則、卡費及貸款依事件日期計入；逾期週期待確認與卡費歸到今天。每日所有事件合計後，日終合計嚴格低於門檻才提示。
            </p>
          </details>
        </>
      )}
    </Stack>
  );
}
