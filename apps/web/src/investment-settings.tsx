// SPDX-License-Identifier: AGPL-3.0-only
import { ItemPicker } from './design/item-picker';
import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import type { Ledger, Item } from '@finmichi/core/catalog-schemas';
import type { Security } from '@finmichi/core/securities-schemas';
import { api, errorMessage } from './api';
import { formatRate } from './design/format';
import { AdminEditor } from './design/admin-editor';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  notify,
} from './design/feedback';
import { navigate, useLocation } from './design/location';
import { IncomeCodesSettings } from './income-codes-settings';
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(
    new Date(),
  );
interface Manual {
  id: string;
  market: string;
  symbol: string;
  price_date: string;
  price: string;
}
export function InvestmentSettings({ ledger }: { ledger: Ledger }) {
  const location = useLocation(),
    query = new URL(location, 'https://local.invalid').searchParams;
  const tab =
    query.get('tab') === 'codes'
      ? 'codes'
      : query.get('tab') === 'prices'
        ? 'prices'
        : 'securities';
  if (ledger.base_currency !== 'TWD')
    return (
      <EmptyState title="投資設定暫不開放">
        股票與股利僅支援新臺幣帳本。
      </EmptyState>
    );
  return (
    <Stack>
      <Group>
        {[
          ['securities', '證券主檔'],
          ['prices', '手動價格'],
          ['codes', '所得代碼'],
        ].map(([key, label]) => (
          <Button
            key={key}
            variant={tab === key ? 'filled' : 'light'}
            onClick={() => navigate('/admin/investment-settings?tab=' + key)}
          >
            {label}
          </Button>
        ))}
      </Group>
      <Text size="sm">
        交割、手續費與損益科目於每筆記帳時選取；目前沒有帳本層級的預設設定。
      </Text>
      {tab === 'codes' ? (
        <IncomeCodesSettings ledger={ledger} />
      ) : (
        <SecuritySettings
          key={tab}
          ledger={ledger}
          pricesOnly={tab === 'prices'}
        />
      )}
    </Stack>
  );
}
function SecuritySettings({
  ledger,
  pricesOnly,
}: {
  ledger: Ledger;
  pricesOnly: boolean;
}) {
  const location = useLocation(),
    query = new URL(location, 'https://local.invalid').searchParams;
  const selected = query.get('security_id'),
    base = `/api/ledgers/${ledger.id}`;
  const [securities, setSecurities] = useState<Security[]>([]),
    [items, setItems] = useState<Item[]>([]),
    [prices, setPrices] = useState<Manual[]>([]);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const [edit, setEdit] = useState<Security | null | undefined>(undefined),
    [confirm, setConfirm] = useState<'delete' | null>(null);
  const [name, setName] = useState(''),
    [symbol, setSymbol] = useState(''),
    [market, setMarket] = useState('TWSE'),
    [kind, setKind] = useState('stock'),
    [holdingItem, setHoldingItem] = useState<string | null>(null),
    [archived, setArchived] = useState(false);
  const [price, setPrice] = useState(''),
    [priceDate, setPriceDate] = useState(today());
  const current = securities.find((s) => s.id === selected);
  const reload = () => {
    setRetry((v) => v + 1);
    window.dispatchEvent(new Event('ledger:catalogs-changed'));
  };
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void Promise.all([
      api<Security[]>(base + '/securities?include_archived=true'),
      api<Item[]>(base + '/items?include_archived=true'),
      api<Manual[]>(base + '/manual-prices'),
    ])
      .then(([s, i, p]) => {
        if (live) {
          setSecurities(s);
          setItems(i);
          setPrices(p);
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
  }, [base, retry]);
  async function saveSecurity() {
    setBusy(true);
    setError('');
    try {
      await api(
        base + '/securities' + (edit ? '/' + edit.id : ''),
        edit ? 'PATCH' : 'POST',
        { name, symbol, market, kind, item_id: holdingItem, archived },
      );
      setEdit(undefined);
      reload();
      notify('證券設定已儲存');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function manual() {
    if (!current) return;
    setBusy(true);
    setError('');
    try {
      await api(base + '/manual-prices', 'POST', {
        market: current.market,
        symbol: current.symbol,
        price_date: priceDate,
        price,
      });
      reload();
      notify('手動價格已儲存');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function openEdit(v: Security | null) {
    setEdit(
      v
        ? {
            id: v.id,
            ledger_id: ledger.id,
            name: v.name,
            symbol: v.symbol,
            market: v.market,
            kind: v.kind,
            item_id: v.item_id,
            archived: v.archived,
          }
        : null,
    );
    setName(v?.name ?? '');
    setSymbol(v?.symbol ?? '');
    setMarket(v?.market ?? 'TWSE');
    setKind(v?.kind ?? 'stock');
    setHoldingItem(v?.item_id ?? null);
    setArchived(v?.archived ?? false);
  }
  return (
    <Stack>
      {error && <ErrorState message={error} retry={reload} />}
      {loading ? (
        <LoadingState label="載入投資設定" />
      ) : (
        <>
          {!pricesOnly && (
            <Button onClick={() => openEdit(null)}>新增證券</Button>
          )}
          {pricesOnly ? (
            <Select
              label="價格證券"
              value={selected}
              searchable
              data={securities.map((s) => ({
                value: s.id,
                label: s.symbol + ' ' + s.name,
              }))}
              onChange={(id) =>
                navigate(
                  '/admin/investment-settings?tab=prices' +
                    (id ? '&security_id=' + id : ''),
                )
              }
            />
          ) : (
            securities.map((s) => (
              <section className="panel" key={s.id}>
                <Group justify="space-between">
                  <strong>
                    {s.symbol} {s.name}
                    {s.archived ? '（封存）' : ''}
                  </strong>
                  <Button
                    aria-label={'編輯證券 ' + s.name}
                    onClick={() => openEdit(s)}
                  >
                    編輯證券
                  </Button>
                </Group>
                <Text>
                  {s.market} · {s.kind === 'etf' ? 'ETF' : '股票'}
                </Text>
                <Text>{items.find((i) => i.id === s.item_id)?.name}</Text>
                <Button
                  variant="subtle"
                  onClick={() =>
                    navigate(
                      '/admin/investment-settings?tab=prices&security_id=' +
                        s.id,
                    )
                  }
                >
                  手動價格 {s.name}
                </Button>
              </section>
            ))
          )}
          {!securities.length && (
            <EmptyState title="尚無證券">
              先建立本位幣資產科目並開啟「證券」旗標，再新增證券。
            </EmptyState>
          )}
          {pricesOnly && current && (
            <>
              <section className="panel">
                <h3>手動價格</h3>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void manual();
                  }}
                >
                  <Group align="end">
                    <TextInput
                      label="價格日期"
                      type="date"
                      value={priceDate}
                      onChange={(e) => setPriceDate(e.currentTarget.value)}
                    />
                    <TextInput
                      label="手動價格"
                      inputMode="decimal"
                      value={price}
                      onChange={(e) => setPrice(e.currentTarget.value)}
                    />
                    <Button type="submit" loading={busy}>
                      儲存手動價格
                    </Button>
                  </Group>
                </form>
                {prices
                  .filter(
                    (p) =>
                      p.market === current.market &&
                      p.symbol === current.symbol,
                  )
                  .map((p) => (
                    <Group key={p.id}>
                      <Text>
                        {p.price_date} · {formatRate(p.price)}
                      </Text>
                      <Button
                        size="xs"
                        variant="subtle"
                        disabled={busy}
                        aria-label={'刪除手動價格 ' + p.price_date}
                        onClick={() => {
                          setBusy(true);
                          void api(base + '/manual-prices/' + p.id, 'DELETE')
                            .then(() => {
                              reload();
                              notify('手動價格已刪除');
                            })
                            .catch((e) => setError(errorMessage(e)))
                            .finally(() => setBusy(false));
                        }}
                      >
                        刪除
                      </Button>
                    </Group>
                  ))}
              </section>
            </>
          )}
        </>
      )}
      <AdminEditor
        opened={edit !== undefined}
        title={edit ? '編輯證券' : '新增證券'}
        busy={busy}
        onClose={() => setEdit(undefined)}
      >
        <Stack>
          {error && <ErrorState message={error} />}
          <TextInput
            label="證券代號"
            value={symbol}
            onChange={(e) => setSymbol(e.currentTarget.value)}
            disabled={busy}
          />
          <TextInput
            label="證券名稱"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            disabled={busy}
          />
          <Select
            label="市場"
            data={['TWSE', 'TPEx']}
            value={market}
            onChange={(v) => setMarket(v ?? 'TWSE')}
            disabled={busy}
          />
          <Select
            label="種類"
            data={[
              { value: 'stock', label: '股票' },
              { value: 'etf', label: 'ETF' },
            ]}
            value={kind}
            onChange={(v) => setKind(v ?? 'stock')}
            disabled={busy}
          />
          <ItemPicker
            items={items}
            label="證券科目"
            data={items
              .filter(
                (i) =>
                  i.securities && i.currency === 'TWD' && i.kind === 'asset',
              )
              .map((i) => ({
                value: i.id,
                label: i.name,
                disabled: i.archived && i.id !== edit?.item_id,
              }))}
            value={holdingItem}
            onChange={setHoldingItem}
            searchable
            disabled={busy}
          />
          <Text size="sm">請先於管理中心建立資產科目並勾選「證券」。</Text>
          <Checkbox
            label="封存證券"
            checked={archived}
            onChange={(e) => setArchived(e.currentTarget.checked)}
            disabled={busy}
          />
          <Group>
            <Button onClick={() => void saveSecurity()} loading={busy}>
              儲存證券
            </Button>
            {edit && (
              <Button
                color="red"
                variant="subtle"
                onClick={() => setConfirm('delete')}
                disabled={busy}
              >
                刪除證券
              </Button>
            )}
          </Group>
        </Stack>
      </AdminEditor>

      <ConfirmDialog
        opened={confirm === 'delete'}
        title="刪除證券"
        confirmLabel="確認刪除"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!edit) return;
          setBusy(true);
          void api(base + '/securities/' + edit.id, 'DELETE')
            .then(() => {
              setEdit(undefined);
              reload();
              notify('證券已刪除');
            })
            .catch((e) => setError(errorMessage(e)))
            .finally(() => {
              setBusy(false);
              setConfirm(null);
            });
        }}
      >
        有交易紀錄的證券無法刪除，請改用封存。
      </ConfirmDialog>
    </Stack>
  );
}
