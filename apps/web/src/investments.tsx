// SPDX-License-Identifier: AGPL-3.0-only
import { HoldingTable } from './holding-table';
import {
  stockUnits,
  stockFixed,
  stockDivide,
} from '@finmichi/core/securities-math';
import { lazy, Suspense } from 'react';
const Deposits = lazy(() =>
  import('./deposits').then((m) => ({ default: m.Deposits })),
);
const Dividends = lazy(() =>
  import('./dividends').then((m) => ({ default: m.Dividends })),
);
const RealizedGains = lazy(() =>
  import('./realized-gains').then((m) => ({ default: m.RealizedGains })),
);
import { useCallback, useEffect, useState, useRef } from 'react';
import { Button, Checkbox, Group, Stack, Text, TextInput } from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import type { StockHolding } from '@finmichi/core';
import { api, errorMessage } from './api';
import { formatMoney, formatPercent, formatRate } from './design/format';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  notify,
} from './design/feedback';
import { AdminEditor } from './design/admin-editor';
import { navigate, useLocation, guardNavigation } from './design/location';
import { StockEntry } from './stock-entry';
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(
    new Date(),
  );
interface History {
  origin: 'app' | 'emoney';
  id: string;
  trade_date: string;
  sequence: number;
  trade_type: string;
  quantity: string | null;
  quantity_after: string | null;
  position_quantity: string;
  position_cost: string;
  gross: string;
  cost_removed: string;
  realized_gain: string;
  note: string;
}
const labels: Record<string, string> = {
  buy: '買進',
  sell: '賣出',
  stock_dividend: '配股',
  adjust: '調整',
};
function HoldingsPage({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    url = new URL(location, 'https://local.invalid'),
    selected = url.pathname.split('/')[2],
    asOf = url.searchParams.get('as_of') ?? today(),
    base = `/api/ledgers/${ledger.id}`;
  const [date, setDate] = useState(asOf),
    [holdings, setHoldings] = useState<StockHolding[]>([]),
    [showClosed, setShowClosed] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0),
    [history, setHistory] = useState<History[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [entry, setEntry] = useState<{ security: string; trade?: string } | null>(
      null,
    ),
    [confirm, setConfirm] = useState<'discard' | null>(null),
    [dirty, setDirty] = useState(false);
  const onDirty = useCallback((v: boolean) => setDirty(v), []),
    onBusy = useCallback((v: boolean) => setBusy(v), []);
  const pendingNavigation = useRef<null | (() => void)>(null);
  useEffect(() => {
    if (!entry) return;
    return guardNavigation((proceed) => {
      if (busy) return;
      if (dirty) {
        pendingNavigation.current = proceed;
        setConfirm('discard');
      } else proceed();
    });
  }, [entry, dirty, busy]);
  useEffect(() => {
    if (!entry) return;
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty || busy) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [entry, dirty, busy]);
  const current = holdings.find((h) => h.id === selected);
  const visible = holdings.filter(
    (h) => showClosed || BigInt(h.quantity) !== 0n,
  );
  const cost = holdings.reduce((n, h) => n + stockUnits(h.cost), 0n),
    value = holdings.reduce((n, h) => n + stockUnits(h.market_amount), 0n),
    delta = value - cost,
    dates = [
      ...new Set(
        holdings
          .filter((h) => BigInt(h.quantity) !== 0n)
          .map((h) => h.price_date ?? '無行情，沿用帳面值'),
      ),
    ].sort();
  useEffect(() => setDate(asOf), [asOf]);
  useEffect(() => {
    if (ledger.base_currency !== 'TWD') return;
    let live = true;
    setLoading(true);
    setError('');
    void Promise.all([
      api<{ items: StockHolding[] }>(
        base + `/reports/holdings?as_of=${encodeURIComponent(asOf)}`,
      ),
      selected
        ? api<{ items: History[]; next_cursor: string | null }>(
            base + `/securities/${selected}/trades?limit=25`,
          )
        : Promise.resolve({ items: [], next_cursor: null }),
    ])
      .then(([h, t]) => {
        if (live) {
          setHoldings(h.items);
          setHistory(t.items);
          setCursor(t.next_cursor);
        }
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
  }, [base, asOf, selected, retry, ledger.base_currency]);
  function reload() {
    setRetry((v) => v + 1);
    window.dispatchEvent(new Event('ledger:transactions-changed'));
  }
  function openEdit(v: StockHolding | null) {
    navigate('/admin/investment-settings' + (v ? '?security_id=' + v.id : ''));
  }
  async function more() {
    setBusy(true);
    try {
      const t = await api<{ items: History[]; next_cursor: string | null }>(
        base +
          `/securities/${selected}/trades?limit=25&cursor=${encodeURIComponent(cursor!)}`,
      );
      setHistory((h) => [...h, ...t.items]);
      setCursor(t.next_cursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const close = () => {
    if (dirty) setConfirm('discard');
    else setEntry(null);
  };
  if (ledger.base_currency !== 'TWD')
    return (
      <EmptyState title="投資暫不開放">
        股票功能目前僅支援本位幣為新臺幣的帳本
      </EmptyState>
    );
  return (
    <Stack className="investments-page">
      <div className="panel-heading">
        <h2>{current ? current.symbol + ' ' + current.name : '投資持股'}</h2>
        <Group>
          {selected ? (
            <Button
              variant="subtle"
              onClick={() => navigate('/investments?as_of=' + asOf)}
            >
              返回持股
            </Button>
          ) : null}
          <Button onClick={() => openEdit(null)}>新增證券</Button>
        </Group>
      </div>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(url.pathname + '?as_of=' + encodeURIComponent(date));
        }}
      >
        <Group align="end">
          <TextInput
            label="估值基準日"
            type="date"
            value={date}
            onChange={(e) => setDate(e.currentTarget.value)}
          />
          <Button type="submit">產生持股</Button>
        </Group>
        <Text size="sm">
          手動價格優先於市場收盤價，僅採基準日或以前資料；無行情以帳面值代替。市值與未實現損益只供檢視，不入帳。
        </Text>
      </form>
      {!selected && !loading && (
        <>
          <section className="panel" aria-label="投資總計">
            <div className="stock-total-grid">
              <div>
                <Text>總市值</Text>
                <strong className="money">
                  {formatMoney(stockFixed(value))}
                </strong>
              </div>
              <div>
                <Text>總成本</Text>
                <strong className="money">
                  {formatMoney(stockFixed(cost))}
                </strong>
              </div>
              <div>
                <Text>總未實現損益</Text>
                <strong className="money">
                  {formatMoney(stockFixed(delta))}（
                  {formatPercent(
                    cost === 0n
                      ? null
                      : stockFixed(stockDivide(delta * 1000000n, cost), 4),
                  )}
                  ）
                </strong>
              </div>
            </div>
            <Text size="sm">
              行情日期：{dates.join('、') || '尚無持股行情'}
            </Text>
          </section>
          <Checkbox
            label="顯示已出清"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.currentTarget.checked)}
          />
        </>
      )}
      {error && <ErrorState message={error} retry={() => reload()} />}
      {loading ? (
        <LoadingState label="載入投資資料" />
      ) : selected && !current ? (
        <EmptyState title="找不到證券" />
      ) : !holdings.length ? (
        <EmptyState
          title="尚無證券"
          action={
            <Button onClick={() => openEdit(null)}>建立第一筆證券</Button>
          }
        >
          先建立本位幣資產科目並開啟「證券」旗標，再新增證券。
        </EmptyState>
      ) : (
        <>
          {!current && (
            <HoldingTable
              holdings={visible}
              asOf={asOf}
              onEntry={(id) => setEntry({ security: id })}
              onEdit={openEdit}
            />
          )}
          {!current && visible.length === 0 && (
            <EmptyState title="沒有未出清部位">
              可勾選「顯示已出清」查看歷史部位。
            </EmptyState>
          )}
          <div className={current ? 'stock-grid' : 'stock-grid stock-mobile'}>
            {(current ? [current] : visible).map((h) => (
              <section className="panel" key={h.id}>
                <h3>
                  <a
                    href={`/investments/${h.id}?as_of=${asOf}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/investments/${h.id}?as_of=${asOf}`);
                    }}
                  >
                    {h.symbol} {h.name}
                  </a>
                  {h.archived ? '（已封存）' : ''}
                </h3>
                <dl className="stock-values">
                  <dt>持股</dt>
                  <dd>{h.quantity} 股</dd>
                  <dt>平均成本</dt>
                  <dd>{formatRate(h.average_cost)}</dd>
                  <dt>帳面成本</dt>
                  <dd className="money">{formatMoney(h.cost)}</dd>
                  <dt>市值</dt>
                  <dd className="money">{formatMoney(h.market_amount)}</dd>
                  <dt>未實現損益</dt>
                  <dd className="money">
                    {formatMoney(h.unrealized_gain)}（
                    {formatPercent(h.return_percent)}）
                  </dd>
                  <dt>已實現損益</dt>
                  <dd className="money">{formatMoney(h.realized_gain)}</dd>
                </dl>
                <Text size="sm">
                  {h.missing
                    ? '無行情，沿用帳面值'
                    : `${h.price_source === 'manual' ? '手動價格' : h.market + ' 收盤價'} ${h.price_date}・${formatRate(h.price)}`}
                </Text>
                {h.stale && (
                  <Text size="sm" style={{ color: 'var(--warn)' }}>
                    行情已過期{h.estimated_days ? '（依平日估算）' : ''}
                  </Text>
                )}
                <Group mt="sm">
                  <Button
                    size="xs"
                    disabled={h.archived}
                    onClick={() => setEntry({ security: h.id })}
                    aria-label={'股票記帳 ' + h.name}
                  >
                    股票記帳
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() =>
                      navigate(
                        '/investments?view=dividends&security_id=' + h.id,
                      )
                    }
                  >
                    股利
                  </Button>
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => openEdit(h)}
                    aria-label={'編輯證券 ' + h.name}
                  >
                    設定
                  </Button>
                </Group>
              </section>
            ))}
          </div>
          {current && (
            <>
              <section className="panel">
                <h3>交易與股數紀錄</h3>
                {!history.length ? (
                  <EmptyState title="尚無交易" />
                ) : (
                  <Stack>
                    {history.map((t) => (
                      <article key={t.id} className="stock-history">
                        <div>
                          <strong>
                            {t.trade_date} · {labels[t.trade_type]} · 同日第{' '}
                            {t.sequence} 筆
                          </strong>
                          <p>
                            異動後 {t.position_quantity} 股・成本{' '}
                            <span className="money">
                              {formatMoney(t.position_cost)}
                            </span>
                          </p>
                          {t.trade_type === 'sell' && (
                            <p>
                              移出成本 {formatMoney(t.cost_removed)}・已實現損益{' '}
                              {formatMoney(t.realized_gain)}
                            </p>
                          )}
                          {t.note && <p>{t.note}</p>}
                        </div>
                        <Button
                          variant="light"
                          size="xs"
                          onClick={() =>
                            setEntry({ security: current.id, trade: t.id })
                          }
                          aria-label={
                            '編輯股票 ' +
                            t.trade_date +
                            ' 第 ' +
                            t.sequence +
                            ' 筆'
                          }
                        >
                          編輯
                        </Button>
                      </article>
                    ))}
                  </Stack>
                )}
                {cursor && (
                  <Button loading={busy} onClick={() => void more()}>
                    載入更多
                  </Button>
                )}
              </section>
              <Button
                variant="light"
                onClick={() =>
                  navigate(
                    '/admin/investment-settings?tab=prices&security_id=' +
                      current.id,
                  )
                }
              >
                手動價格設定
              </Button>
            </>
          )}
        </>
      )}
      <AdminEditor
        opened={!!entry}
        desktopSize={420}
        title="股票記帳"
        busy={busy}
        onClose={close}
      >
        {entry && (
          <StockEntry
            key={entry.security + ':' + (entry.trade ?? 'new')}
            ledger={ledger}
            initialSecurity={entry.security}
            initialTrade={entry.trade}
            allowAdjust
            onDirtyChange={onDirty}
            onBusyChange={onBusy}
            onClose={close}
            onSaved={() => {
              setEntry(null);
              setBusy(false);
              setDirty(false);
              reload();
              notify('股票紀錄已儲存');
            }}
          />
        )}
      </AdminEditor>
      <ConfirmDialog
        opened={!!confirm}
        title="未儲存內容"
        confirmLabel="捨棄變更"
        onCancel={() => {
          pendingNavigation.current = null;
          setConfirm(null);
        }}
        onConfirm={() => {
          if (confirm === 'discard') {
            setEntry(null);
            setDirty(false);
            setConfirm(null);
            const proceed = pendingNavigation.current;
            pendingNavigation.current = null;
            proceed?.();
          }
        }}
        busy={busy}
      >
        <Text>有未儲存的股票變更，確定捨棄嗎？</Text>
      </ConfirmDialog>
    </Stack>
  );
}

export function Investments({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    url = new URL(location, 'https://local.invalid');
  const tab =
    url.searchParams.get('tab') ?? url.searchParams.get('view') ?? 'holdings';
  const tabs = [
    ['holdings', '持股'],
    ['realized-gains', '已實現損益'],
    ['dividends', '股利'],
    ['deposits', '定存'],
  ] as const;
  const selected = tabs.some(([key]) => key === tab) ? tab : 'holdings';
  return (
    <Stack>
      <Group role="group" aria-label="投資檢視">
        {tabs.map(([key, label]) => (
          <Button
            key={key}
            variant={selected === key ? 'filled' : 'light'}
            aria-pressed={selected === key}
            disabled={ledger.base_currency !== 'TWD' && key !== 'deposits'}
            onClick={() =>
              navigate(
                '/investments' + (key === 'holdings' ? '' : '?tab=' + key),
              )
            }
          >
            {label}
          </Button>
        ))}
      </Group>
      {selected === 'deposits' ? (
        <Suspense fallback={<LoadingState label="載入定存頁" />}>
          <Deposits ledger={ledger} />
        </Suspense>
      ) : selected === 'dividends' && ledger.base_currency === 'TWD' ? (
        <Suspense fallback={<LoadingState label="載入股利頁" />}>
          <Dividends ledger={ledger} />
        </Suspense>
      ) : selected === 'realized-gains' && ledger.base_currency === 'TWD' ? (
        <Suspense fallback={<LoadingState label="載入損益頁" />}>
          <RealizedGains ledger={ledger} />
        </Suspense>
      ) : (
        <HoldingsPage ledger={ledger} />
      )}
    </Stack>
  );
}
