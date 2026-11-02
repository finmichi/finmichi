// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  FileInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import type {
  MarketDashboard,
  FxUploadPreview,
} from '@finmichi/core/market-schemas';
import { api, errorMessage } from './api';
import { formatRate, formatFullRate } from './design/format';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  notify,
} from './design/feedback';
import { EdgeScroll } from './design/edge-scroll';
import { generatedAt } from './report-common';
import { marketFailureMessage } from './market-status';
export function MarketRates({ ledger }: { ledger: Ledger }) {
  const path = `/api/ledgers/${ledger.id}/market`;
  const [data, setData] = useState<MarketDashboard | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const [file, setFile] = useState<File | null>(null),
    [content, setContent] = useState(''),
    [date, setDate] = useState(''),
    [preview, setPreview] = useState<FxUploadPreview | null>(null),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const selection = useRef(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void api<MarketDashboard>(path)
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [path, revision]);
  const input = () => ({
    filename: file!.name,
    content,
    ...(date ? { rate_date: date } : {}),
  });
  const dated = !!file && /^ExchangeRate@\d{12}\.csv$/i.test(file.name);
  const rate = (v: string | null) =>
    v === null ? '—' : <span title={formatFullRate(v)}>{formatRate(v)}</span>;
  return (
    <Stack className="market-rates-page">
      <Title order={2}>匯率</Title>
      <Text size="sm" c="dimmed">
        臺銀牌告為共用市場參考資料，不會改寫既有交易的帳面匯率。
      </Text>
      {error && (
        <ErrorState message={error} retry={() => setRevision((x) => x + 1)} />
      )}
      {loading && <LoadingState label="行情載入中" hasData={data !== null} />}
      {data?.runs.map((r) => (
        <section key={r.source} className="panel market-source-status">
          <strong>
            {
              {
                bot: '臺灣銀行',
                twse: '證交所',
                tpex: '櫃買中心',
                calendar: '交易日曆',
              }[r.source]
            }
          </strong>
          {r.source === 'twse' && (
            <Text size="xs" c="dimmed">
              資料來源：金融監督管理委員會證券期貨局／臺灣證券交易所，
              <a
                href="https://data.gov.tw/dataset/11549"
                target="_blank"
                rel="noreferrer"
              >
                盤後個股日成交資訊
              </a>
              ，
              <a
                href="https://data.gov.tw/license"
                target="_blank"
                rel="noreferrer"
              >
                政府資料開放授權條款第 1 版
              </a>
              。
            </Text>
          )}
          <Text size="sm">
            行情資料日期：{r.data_date ?? '尚無資料'}
            {r.last_finished_at
              ? ' · 最近執行 ' + generatedAt(r.last_finished_at)
              : ''}
          </Text>
          {r.stale && r.status !== 'blocked_by_source' && (
            <p className="market-warning">
              行情已超過 3 個應有交易日未更新
              {r.estimated_days ? '（依平日估算）' : ''}。
            </p>
          )}
          {r.status === 'blocked_by_source' ? (
            <p className="market-warning">
              {r.source === 'bot'
                ? '臺銀匯率無法自動取得，請手動上傳 CSV'
                : '行情來源暫時阻擋自動取得，保留既有資料；不會繞過驗證。'}
            </p>
          ) : r.status === 'error' ? (
            <p className="market-warning">
              {marketFailureMessage(r.error_code)} 保留既有資料。
            </p>
          ) : r.status === 'warning' &&
            r.error_code !== 'many_missing_prices' ? (
            <p className="market-warning">
              {r.error_code === 'calendar_partial'
                ? '日曆資料不足，缺漏日期依平日估算。'
                : '部分報價缺漏，請留意各科目實際行情日期。'}
            </p>
          ) : (
            <Text size="sm" c="dimmed">
              {r.status === 'skipped_holiday'
                ? '休市日略過'
                : r.status === 'running'
                  ? '更新中'
                  : r.status === 'no_new_data'
                    ? '尚無較新資料'
                    : '資料已保留'}
              {r.method === 'upload' ? ' · 手動上傳' : ''}
            </Text>
          )}
          {data.price_coverage
            ?.filter((c) => c.source === r.source)
            .map((c) => (
              <div key={c.source}>
                {c.missing_prices > 0 && (
                  <p className="market-warning">
                    目前帳本有 {c.missing_prices} 個未封存證券缺少最新價格 （
                    {c.data_date ?? '尚無來源日期'}），請留意實際行情日期。
                  </p>
                )}
                {r.skipped_no_price > 0 && (
                  <details className="market-price-details">
                    <summary>來源報價明細</summary>
                    <Text size="sm" c="dimmed">
                      來源中 {r.skipped_no_price} 筆沒有成交價
                      {c.missing_prices === 0
                        ? '，不影響目前帳本的未封存證券。'
                        : '；已依目前帳本列出缺價提醒。'}
                    </Text>
                  </details>
                )}
              </div>
            ))}
          {(r.status === 'error' || r.status === 'blocked_by_source') && (
            <Text size="sm" className="market-retry">
              錯誤代碼：{r.error_code ?? 'source_unavailable'} · 下次重試：
              {r.next_retry_at
                ? generatedAt(r.next_retry_at)
                : r.status === 'blocked_by_source'
                  ? r.source === 'bot'
                    ? '今日已停止自動重試，可手動上傳 CSV。'
                    : '今日已停止自動重試，請待來源恢復。'
                  : '尚未排定，請稍後查看。'}
            </Text>
          )}
        </section>
      ))}
      {data?.price_coverage
        ?.filter(
          (c) =>
            c.missing_prices > 0 &&
            !data.runs.some((r) => r.source === c.source),
        )
        .map((c) => (
          <section key={c.source} className="panel market-source-status">
            <strong>{c.source === 'twse' ? '證交所' : '櫃買中心'}</strong>
            <p className="market-warning">
              尚未取得來源行情，目前帳本有 {c.missing_prices}{' '}
              個未封存證券缺少最新價格。
            </p>
          </section>
        ))}
      <form
        className="panel market-upload"
        onSubmit={(e) => {
          e.preventDefault();
          if (!file || !content) return;
          setBusy(true);
          setError('');
          void api<FxUploadPreview>(path + '/fx-preview', 'POST', input())
            .then(setPreview)
            .catch((e) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        <h3>手動上傳臺銀匯率 CSV</h3>
        <Text size="sm">
          請選擇從臺銀下載的公開牌告
          CSV；系統沿用自動抓取的相同解析規則。無日期檔名時必須填寫掛牌日期，不會預設今天。
        </Text>
        <FileInput
          label="臺銀匯率 CSV"
          accept=".csv,text/csv"
          value={file}
          disabled={busy}
          clearable
          clearButtonProps={{
            'aria-label': '清除臺銀匯率檔案',
            style: { width: 44, height: 44 },
          }}
          rightSectionWidth={44}
          onChange={(f) => {
            const ticket = ++selection.current;
            setFile(f);
            setContent('');
            setDate('');
            setPreview(null);
            setError('');
            if (f) {
              if (f.size > 1_000_000) {
                setError('檔案超過 1 MB 上限。');
                return;
              }
              void f
                .arrayBuffer()
                .then((b) => {
                  const text = new TextDecoder('utf-8', { fatal: true }).decode(
                    b,
                  );
                  if (selection.current === ticket) setContent(text);
                })
                .catch(() => {
                  if (selection.current === ticket)
                    setError('無法讀取檔案，請使用 UTF-8 臺銀 CSV。');
                });
            }
          }}
        />
        <TextInput
          type="date"
          label="掛牌日期"
          description={
            dated
              ? '檔名含日期，解析時優先使用檔名日期。'
              : '檔名無日期時必填；請依臺銀牌告日期輸入。'
          }
          value={date}
          required={!dated}
          disabled={busy}
          onChange={(e) => {
            setDate(e.currentTarget.value);
            setPreview(null);
          }}
        />
        <Button
          type="submit"
          mih={44}
          loading={busy}
          disabled={!file || !content || (!dated && !date)}
        >
          預覽匯率 CSV
        </Button>
        {preview && (
          <section className="market-upload-preview" aria-label="匯率上傳預覽">
            <h3>上傳預覽</h3>
            <Text>
              掛牌日期：{preview.data_date}（
              {preview.date_source === 'filename' ? '依檔名' : '使用者指定'}）
            </Text>
            <Text>
              可接受 {preview.accepted} 筆，無報價略過 {preview.skipped_no_rate}{' '}
              筆
            </Text>
            <Text size="sm">
              確認後更新共用市場快取；較舊日期不取代新資料，不產生帳務分錄。
            </Text>
            <Button mih={44} disabled={busy} onClick={() => setConfirm(true)}>
              確認上傳匯率
            </Button>
          </section>
        )}
      </form>
      {data &&
        !loading &&
        (data.rates.length ? (
          <section className="panel">
            <h3>最新臺銀匯率</h3>
            <EdgeScroll axis="x" label="臺銀匯率表">
              <table className="market-rate-table">
                <thead>
                  <tr>
                    {[
                      '幣別',
                      '行情日期',
                      '即期買入',
                      '即期賣出',
                      '現金買入',
                      '現金賣出',
                    ].map((v) => (
                      <th key={v}>{v}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rates.map((r) => (
                    <tr key={r.currency}>
                      <th>{r.currency}</th>
                      <td>
                        {r.rate_date}
                        {r.method === 'upload' ? '（上傳）' : ''}
                      </td>
                      <td>{rate(r.spot_buy)}</td>
                      <td>{rate(r.spot_sell)}</td>
                      <td>{rate(r.cash_buy)}</td>
                      <td>{rate(r.cash_sell)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </EdgeScroll>
          </section>
        ) : (
          <EmptyState title="尚無市場匯率">
            可以先手動上傳臺銀 CSV；缺資料的科目仍以帳面值呈現。
          </EmptyState>
        ))}
      <ConfirmDialog
        busy={busy}
        opened={confirm}
        title="確認上傳臺銀匯率"
        confirmLabel="更新市場匯率"
        onCancel={() => {
          if (!busy) setConfirm(false);
        }}
        onConfirm={() => {
          if (busy || !preview) return;
          setBusy(true);
          setError('');
          void api<{ accepted: number }>(path + '/fx-upload', 'POST', input())
            .then((r) => {
              setConfirm(false);
              setPreview(null);
              setFile(null);
              setContent('');
              setDate('');
              setRevision((x) => x + 1);
              notify(
                r.accepted
                  ? '市場匯率已更新。'
                  : '來源資料較舊或沒有報價，保留原有快取。',
              );
            })
            .catch((e) => {
              setConfirm(false);
              setError(errorMessage(e));
            })
            .finally(() => setBusy(false));
        }}
      >
        <Text>
          掛牌日期：{preview?.data_date}，可接受 {preview?.accepted}{' '}
          筆。這不會修改任何交易。
        </Text>
      </ConfirmDialog>
    </Stack>
  );
}
