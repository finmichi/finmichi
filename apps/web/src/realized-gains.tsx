// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import { api, errorMessage } from './api';
import { EmptyState, ErrorState, LoadingState } from './design/feedback';
import { formatMoney } from './design/format';
import { navigate, useLocation } from './design/location';
interface RealizedReport {
  total: string;
  booked_total: string;
  unbooked_total: string;
  items: {
    security_id: string;
    name: string;
    symbol: string;
    market: string;
    origin: 'app' | 'emoney';
    booked: boolean;
    booked_total: string;
    unbooked_total: string;
    trade_count: number;
    gross: string;
    cost_removed: string;
    fees: string;
    realized_gain: string;
  }[];
}
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(
    new Date(),
  );
export function RealizedGains({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    q = new URL(location, 'https://local.invalid').searchParams,
    dateTo = q.get('date_to') ?? today(),
    dateFrom = q.get('date_from') ?? dateTo.slice(0, 7) + '-01';
  const [from, setFrom] = useState(dateFrom),
    [to, setTo] = useState(dateTo),
    [report, setReport] = useState<RealizedReport | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const fromUrl = q.get('date_from'),
    toUrl = q.get('date_to');
  useEffect(() => {
    if (!fromUrl || !toUrl)
      navigate(
        '/investments?' +
          new URLSearchParams({
            view: 'realized-gains',
            date_from: dateFrom,
            date_to: dateTo,
          }),
        true,
      );
  }, [fromUrl, toUrl, dateFrom, dateTo]);
  useEffect(() => {
    setFrom(dateFrom);
    setTo(dateTo);
  }, [dateFrom, dateTo]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    void api<RealizedReport>(
      `/api/ledgers/${ledger.id}/reports/realized-gains?${query}`,
    )
      .then((r) => {
        if (live) setReport(r);
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
  }, [ledger.id, dateFrom, dateTo, retry]);
  function generate() {
    navigate(
      '/investments?' +
        new URLSearchParams({
          view: 'realized-gains',
          date_from: from,
          date_to: to,
        }),
    );
  }
  return (
    <Stack>
      <h2>已實現損益</h2>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          generate();
        }}
      >
        <Group align="end">
          <TextInput
            label="損益起日"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.currentTarget.value)}
          />
          <TextInput
            label="損益迄日"
            type="date"
            value={to}
            onChange={(e) => setTo(e.currentTarget.value)}
          />
          <Button type="submit">產生損益報表</Button>
        </Group>
        <Text size="sm">
          依交易日期統計淨損益（已扣賣出手續費與證交稅），包含股數／成本調整認列的損益。現金股利請見股利報表；未入帳損益僅供對帳，不計入損益表。
        </Text>
      </form>
      {error ? (
        <ErrorState message={error} retry={() => setRetry((v) => v + 1)} />
      ) : loading ? (
        <LoadingState label="載入已實現損益" />
      ) : (
        report && (
          <>
            <section className="panel">
              <h3>期間已入帳損益</h3>
              <strong className="money">
                {formatMoney(report.booked_total)}
              </strong>
              <h3>未入帳損益</h3>
              <strong className="money">
                {formatMoney(report.unbooked_total)}
              </strong>
              <Text size="sm">
                {dateFrom} 至 {dateTo}
              </Text>
            </section>
            {!report.items.some((r) => r.trade_count > 0) ? (
              <EmptyState title="期間內尚無股票紀錄" />
            ) : (
              <div className="stock-grid">
                {report.items
                  .filter((r) => r.trade_count > 0)
                  .map((r) => (
                    <section
                      className="panel"
                      key={`${r.security_id}:${r.origin}:${r.booked}`}
                    >
                      <h3>
                        <a
                          href={`/investments/${r.security_id}?as_of=${dateTo}`}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate(
                              `/investments/${r.security_id}?as_of=${dateTo}`,
                            );
                          }}
                        >
                          {r.symbol} {r.name}
                        </a>
                      </h3>
                      <Text size="sm">{r.booked ? '已入帳' : '未入帳'}</Text>
                      <dl className="stock-values">
                        <dt>紀錄筆數</dt>
                        <dd>{r.trade_count}</dd>
                        <dt>賣出價金</dt>
                        <dd className="money">{formatMoney(r.gross)}</dd>
                        <dt>成本移出</dt>
                        <dd className="money">{formatMoney(r.cost_removed)}</dd>
                        <dt>賣出費用及稅</dt>
                        <dd className="money">{formatMoney(r.fees)}</dd>
                        <dt>淨損益</dt>
                        <dd className="money">
                          {formatMoney(r.realized_gain)}
                        </dd>
                      </dl>
                    </section>
                  ))}
              </div>
            )}
          </>
        )
      )}
    </Stack>
  );
}
