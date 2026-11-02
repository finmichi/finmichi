// SPDX-License-Identifier: AGPL-3.0-only
import { EdgeScroll } from './design/edge-scroll';
import { LoadingState, ErrorState } from './design/feedback';
import { useLocation } from './design/location';
import { useEffect, useState } from 'react';
import { Button, Stack, Text, TextInput, Title, Badge } from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import type { BalanceReport } from '@finmichi/core/report-schemas';
import { formatMoney, formatRate, formatFullRate } from './design/format';
import {
  balanceOriginalAmount,
  naturalOriginalAmount,
} from './design/report-presentation';
import { add } from './design/display-math';
import { useTransactionRevision } from './design/data-revision';
import { api, errorMessage } from './api';
import {
  generatedAt,
  todayTaipei,
  downloadReport,
  ReportTree,
} from './report-common';
export function BalanceSheet({ ledger }: { ledger: Ledger }) {
  const location = useLocation();
  const transactionRevision = useTransactionRevision();
  const linkedDate = new URLSearchParams(location.split('?')[1] ?? '').get(
    'as_of',
  );
  const validLink =
    linkedDate && /^\d{4}-\d{2}-\d{2}$/.test(linkedDate) ? linkedDate : null;
  const [draft, setDraft] = useState(() => validLink ?? todayTaipei()),
    [applied, setApplied] = useState(draft),
    [report, setReport] = useState<BalanceReport | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false);
  useEffect(() => {
    if (validLink) {
      setDraft(validLink);
      setApplied(validLink);
    }
  }, [validLink]);
  const path = `/api/ledgers/${ledger.id}/reports/balance-sheet`;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    void api<BalanceReport>(
      path + '?' + new URLSearchParams({ as_of: applied }),
    )
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
  }, [path, applied, revision, transactionRevision]);
  const display = (
    v: string,
    currency = ledger.base_currency,
    compact = false,
  ) => formatMoney(v, currency, { compact });
  return (
    <Stack className="report-page">
      <Title order={2}>資產負債表</Title>
      {error && (
        <ErrorState message={error} retry={() => setRevision((v) => v + 1)} />
      )}
      <form
        className="panel report-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
          setRevision((v) => v + 1);
        }}
      >
        <TextInput
          type="date"
          label="基準日"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <Button type="submit" disabled={busy}>
          產生資產負債表
        </Button>
        <Button
          variant="default"
          disabled={
            !report || !!error || busy || exporting || draft !== applied
          }
          onClick={() => {
            setExporting(true);
            void downloadReport(
              path + '.csv?' + new URLSearchParams({ as_of: applied }),
              'balance-sheet.csv',
            )
              .catch((e) => setError(errorMessage(e)))
              .finally(() => setExporting(false));
          }}
        >
          匯出資產負債表 CSV
        </Button>
      </form>
      {busy && <LoadingState label="報表產生中" hasData={report !== null} />}
      {report && (
        <>
          <div
            className={
              'report-identity ' +
              (report.totals.is_balanced ? 'balanced' : 'unbalanced')
            }
            role="status"
          >
            {report.totals.is_balanced
              ? '✓ 恆等式驗算通過'
              : '恆等式驗算不平衡'}
            ：資產 − 負債 ＝ 權益 ＋ 累積淨收支
            <span>差額 {display(report.totals.identity_difference)}</span>
          </div>
          {report.items.some((i) => i.currency !== ledger.base_currency) && (
            <p className="report-fx-note">外幣以歷史帳面值計。</p>
          )}
          <div className="report-kpis">
            {[
              ['資產合計', report.totals.assets],
              ['負債合計', report.totals.liabilities],
              ['淨值', report.totals.net_worth],
              [
                '權益＋累積淨收支',
                add([report.totals.equity, report.totals.net_income]),
              ],
            ].map(([label, value]) => (
              <section className="panel report-kpi" key={label}>
                <div>{label}</div>
                <strong>{display(value!, ledger.base_currency, true)}</strong>
              </section>
            ))}
          </div>
          {report.market && (
            <>
              <div className="report-kpis market-kpis">
                <section className="panel report-kpi">
                  <div>市值淨值</div>
                  <strong>
                    {display(
                      report.market.net_worth,
                      ledger.base_currency,
                      true,
                    )}
                  </strong>
                </section>
                <section className="panel report-kpi">
                  <div>未實現損益（淨值差額）</div>
                  <strong>
                    {display(
                      report.market.unrealized_amount,
                      ledger.base_currency,
                      true,
                    )}
                  </strong>
                </section>
              </div>
              <Text size="sm" c="dimmed">
                {report.market.stock_notice}。市值只供檢視，不入帳。
              </Text>
              {report.market.runs
                .filter((r) => r.source !== 'calendar')
                .map((r) => (
                  <Text key={r.source} size="sm" c="dimmed">
                    {
                      { bot: '臺銀', twse: '上市', tpex: '上櫃' }[
                        r.source as 'bot' | 'twse' | 'tpex'
                      ]
                    }
                    行情資料日期：{r.data_date ?? '尚無資料'}
                    {r.status === 'warning' && (
                      <span className="market-warning"> · 部分報價缺漏</span>
                    )}
                  </Text>
                ))}
              {report.items.some((i) => i.valuation?.stale) && (
                <p className="market-warning" role="status">
                  {report.market.runs.some(
                    (r) =>
                      r.source === 'bot' && r.status === 'blocked_by_source',
                  )
                    ? '臺銀匯率無法自動取得，請手動上傳 CSV'
                    : '匯率已超過 3 個平日未更新（依平日估算），請留意行情日期。'}
                </p>
              )}
            </>
          )}
          <Text size="sm" c="dimmed">
            基準日：{report.as_of}；產生時間：{generatedAt(report.generated_at)}
          </Text>
          <div className="report-balance-grid market-balance-grid">
            {(['asset', 'liability', 'equity'] as const).map((kind) => (
              <section
                className={'panel report-section report-' + kind}
                key={kind}
              >
                <div className="panel-heading">
                  <h3>
                    {{ asset: '資產', liability: '負債', equity: '權益' }[kind]}
                  </h3>
                  <span className="num">
                    {display(
                      report.totals[
                        kind === 'asset'
                          ? 'assets'
                          : kind === 'liability'
                            ? 'liabilities'
                            : 'equity'
                      ],
                    )}
                  </span>
                </div>
                <EdgeScroll
                  axis="x"
                  label={
                    '資產負債表' +
                    { asset: '資產', liability: '負債', equity: '權益' }[kind] +
                    '明細'
                  }
                >
                  <ReportTree
                    defaultExpandRoots
                    rows={report.items.filter((i) => i.kind === kind)}
                    columns={[
                      {
                        label: '原幣餘額',
                        render: (i, mobile) =>
                          i.currency === ledger.base_currency ? (
                            <span>—</span>
                          ) : (
                            <span
                              className="report-money"
                              title={
                                '自身原幣餘額：' +
                                display(
                                  naturalOriginalAmount(
                                    i.kind,
                                    i.own_original_amount,
                                  ),
                                  i.currency,
                                ) +
                                '；子樹：' +
                                i.original_balances
                                  .map((v) =>
                                    display(
                                      naturalOriginalAmount(
                                        i.kind,
                                        v.original_amount,
                                      ),
                                      v.currency,
                                    ),
                                  )
                                  .join('、')
                              }
                            >
                              {display(
                                balanceOriginalAmount(i),
                                i.currency,
                                mobile,
                              )}
                            </span>
                          ),
                      },
                      {
                        label: '帳面值',
                        render: (i, mobile) => (
                          <div className="report-amount">
                            <span
                              className="report-amount-main report-money"
                              title={
                                '自身帳面值：' +
                                display(i.own_book_amount) +
                                '；子樹帳面值：' +
                                display(i.book_amount)
                              }
                            >
                              {display(
                                i.book_amount,
                                ledger.base_currency,
                                mobile,
                              )}
                            </span>
                            <span className="report-flags">
                              {i.archived && (
                                <Badge variant="light" color="gray">
                                  已封存
                                </Badge>
                              )}
                              {i.credit_card && (
                                <Badge variant="light">信用卡</Badge>
                              )}
                              {i.loan && <Badge variant="light">貸款</Badge>}
                            </span>
                          </div>
                        ),
                      },
                      {
                        label: '市值',
                        render: (i, mobile) => (
                          <div className="market-item-value">
                            <strong className="report-money">
                              {display(
                                i.valuation?.market_amount ?? i.book_amount,
                                ledger.base_currency,
                                mobile,
                              )}
                            </strong>
                            {i.valuation?.rate && (
                              <Text
                                size="xs"
                                c="dimmed"
                                title={formatFullRate(i.valuation.rate)}
                              >
                                {i.valuation.source === 'bot-cross'
                                  ? '交叉匯率（臺銀）'
                                  : '臺銀中價'}{' '}
                                {formatRate(i.valuation.rate)} ·{' '}
                                {i.valuation.rate_date}
                              </Text>
                            )}
                            {i.valuation?.stock_quotes?.map((q) => (
                              <Text key={q.id} size="xs" c="dimmed">
                                {q.symbol} {q.quantity} 股 ·{' '}
                                {q.missing
                                  ? '無行情，沿用帳面值'
                                  : `${q.price_source === 'manual' ? '手動價格' : q.market} ${formatRate(q.price)} · ${q.price_date}`}
                              </Text>
                            ))}
                            {i.valuation?.missing && (
                              <Text size="xs" c="dimmed">
                                無行情（以帳面值代替）
                              </Text>
                            )}
                            {i.valuation?.stale && (
                              <Text size="xs" className="market-warning">
                                行情已過期
                                {i.valuation.estimated_days
                                  ? '（依平日估算）'
                                  : ''}
                              </Text>
                            )}
                          </div>
                        ),
                      },
                      {
                        label: '未實現損益',
                        render: (i, mobile) => (
                          <span className="report-money">
                            {display(
                              i.valuation?.unrealized_amount ?? '0.00',
                              ledger.base_currency,
                              mobile,
                            )}
                          </span>
                        ),
                      },
                    ]}
                  />
                </EdgeScroll>
              </section>
            ))}
          </div>
          <details className="panel report-note">
            <summary>計算說明</summary>
            <p>
              帳面值依歷史分錄加總，不依現行匯率改寫；市值另以基準日之前最近的臺銀中價重估，不產生分錄。原幣與帳面值同為自然方向，本位幣科目不另顯示原幣餘額；各幣別分開，自身與含子科目小計不可重複相加。
            </p>
            <p>
              權益合計：{display(report.totals.equity)} · 累積淨收支：
              {display(report.totals.net_income)}
            </p>
          </details>
        </>
      )}
    </Stack>
  );
}
