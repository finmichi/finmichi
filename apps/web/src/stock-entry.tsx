// SPDX-License-Identifier: AGPL-3.0-only
import { ItemPicker } from './design/item-picker';
import { useEffect, useState } from 'react';
import {
  Button,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import type { Item, Ledger } from '@finmichi/core/catalog-schemas';
import type { Security } from '@finmichi/core/securities-schemas';
import { api, errorMessage } from './api';
import { ConfirmDialog, ErrorState, LoadingState } from './design/feedback';
import { formatMoney, formatRate } from './design/format';
import { EdgeScroll } from './design/edge-scroll';
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(
    new Date(),
  );
export interface StockForm {
  trade_type: string;
  trade_date: string;
  quantity: string;
  price: string;
  fee: string;
  tax: string;
  note: string;
  settlement_item_id: string | null;
  expense_item_id: string | null;
  gain_item_id: string | null;
  quantity_after: string;
  cost_mode: string;
  cost_after: string;
  cash_amount: string;
  sequence: string;
}
const empty = (): StockForm => ({
  trade_type: 'buy',
  trade_date: today(),
  quantity: '',
  price: '',
  fee: '0',
  tax: '0',
  note: '',
  settlement_item_id: null,
  expense_item_id: null,
  gain_item_id: null,
  quantity_after: '',
  cost_mode: 'keep',
  cost_after: '',
  cash_amount: '',
  sequence: '',
});
interface Trade extends Record<string, unknown> {
  id: string;
  security_id: string;
  transaction_id: string | null;
}
interface StockPreview {
  preview_hash: string;
  entries: {
    item_id: string;
    amount: string;
    base_amount: string;
    currency: string;
  }[];
  position: {
    quantity_after: string;
    cost_after: string;
    average_cost: string;
    realized_gain: string;
  } | null;
  recalculations: {
    transaction_id: string | null;
    trade_date: string;
    old_gain: string;
    new_gain: string;
    old_cost: string;
    new_cost: string;
  }[];
}
export function StockEntry({
  ledger,
  initialSecurity,
  initialTrade,
  allowAdjust = false,
  onDirtyChange,
  onBusyChange,
  onSaved,
  onClose,
}: {
  ledger: Ledger;
  initialSecurity?: string | undefined;
  initialTrade?: string | undefined;
  allowAdjust?: boolean;
  onDirtyChange: (v: boolean) => void;
  onBusyChange: (v: boolean) => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const base = `/api/ledgers/${ledger.id}`;
  const [securities, setSecurities] = useState<Security[]>([]),
    [items, setItems] = useState<Item[]>([]),
    [security, setSecurity] = useState(initialSecurity ?? ''),
    [imported, setImported] = useState(false),
    [form, setForm] = useState(empty),
    [baseline, setBaseline] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<StockPreview | null>(null),
    [confirm, setConfirm] = useState<'save' | 'delete' | null>(null),
    [retry, setRetry] = useState(0);
  const snapshot = JSON.stringify([security, form]);
  useEffect(() => {
    onDirtyChange(!loading && snapshot !== baseline);
  }, [snapshot, baseline, loading, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void (async () => {
      const [s, i] = await Promise.all([
        api<Security[]>(base + '/securities'),
        api<Item[]>(base + '/items?include_archived=true'),
      ]);
      let f = empty();
      let isImported = false;
      const id = initialSecurity ?? s.find((v) => !v.archived)?.id ?? '';
      if (initialTrade && initialSecurity) {
        const r = await api<Trade>(
          base + `/securities/${initialSecurity}/trade/${initialTrade}`,
        );
        isImported = r.origin === 'emoney';
        for (const k of Object.keys(f) as (keyof StockForm)[]) {
          const v = r[k];
          if (v !== undefined && v !== null) f = { ...f, [k]: String(v) };
        }
      }
      if (live) {
        setSecurities(s);
        setItems(i);
        setForm(f);
        setImported(isImported);
        setSecurity(id);
        setBaseline(JSON.stringify([id, f]));
        setError('');
      }
    })()
      .catch((e) => {
        if (live) setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [base, initialSecurity, initialTrade, retry]);
  function change<K extends keyof StockForm>(k: K, v: StockForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setPreview(null);
    setError('');
  }
  function input() {
    const common = {
      trade_type: form.trade_type,
      trade_date: form.trade_date,
      note: form.note,
      ...(form.sequence ? { sequence: Number(form.sequence) } : {}),
      settlement_item_id: form.settlement_item_id,
      expense_item_id: form.expense_item_id,
      gain_item_id: form.gain_item_id,
    };
    return form.trade_type === 'adjust'
      ? {
          ...common,
          quantity_after: form.quantity_after,
          cost_mode: form.cost_mode,
          ...(form.cost_mode === 'set_cost'
            ? { cost_after: form.cost_after }
            : form.cost_mode === 'cash_return'
              ? { cash_amount: form.cash_amount }
              : {}),
        }
      : form.trade_type === 'stock_dividend'
        ? { ...common, quantity: form.quantity }
        : {
            ...common,
            quantity: form.quantity,
            price: form.price,
            fee: form.fee,
            tax: form.tax,
          };
  }
  async function trial(remove = false) {
    setBusy(true);
    setError('');
    try {
      const p = await api<StockPreview>(
        base + `/securities/${security}/trade-preview`,
        'POST',
        {
          operation: remove ? 'delete' : initialTrade ? 'update' : 'create',
          ...(initialTrade ? { trade_id: initialTrade } : {}),
          ...(!remove ? { trade: input() } : {}),
        },
      );
      setPreview(p);
      if (remove) setConfirm('delete');
      return p;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function save(p: StockPreview, remove = false) {
    setBusy(true);
    setError('');
    try {
      await api(
        base +
          `/securities/${security}/trades${initialTrade ? '/' + initialTrade : ''}`,
        remove ? 'DELETE' : initialTrade ? 'PUT' : 'POST',
        {
          ...(!remove ? { trade: input() } : {}),
          preview_hash: p.preview_hash,
          confirm_recalculation: true,
        },
      );
      onDirtyChange(false);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setPreview(null);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }
  const options = (kind: string, flag = false) =>
    items
      .filter(
        (i) =>
          i.kind === kind &&
          i.currency === 'TWD' &&
          (kind === 'asset'
            ? Boolean(i.securities) === flag
            : !!i.non_operating),
      )
      .map((i) => ({
        value: i.id,
        label: i.name + (i.archived ? '（已封存）' : ''),
        disabled:
          i.archived &&
          ![
            form.settlement_item_id,
            form.expense_item_id,
            form.gain_item_id,
          ].includes(i.id),
      }));
  if (loading) return <LoadingState label="載入股票記帳" />;
  return (
    <EdgeScroll label="股票記帳內容">
      <Stack className="stock-entry">
        <h3>{initialTrade ? '修改股票紀錄' : '股票記帳'}</h3>
        {error && (
          <ErrorState
            message={error}
            retry={() => {
              if (securities.length) void trial();
              else setRetry((v) => v + 1);
            }}
          />
        )}
        {!securities.length && <Text>請先到「投資」建立證券與證券科目。</Text>}
        <Select
          label="證券"
          data={securities.map((s) => ({
            value: s.id,
            label: s.symbol + ' ' + s.name,
            disabled: s.archived && s.id !== initialSecurity,
          }))}
          value={security || null}
          onChange={(v) => {
            setSecurity(v ?? '');
            setPreview(null);
          }}
          disabled={busy || !!initialTrade}
          searchable
        />
        <Select
          label="股票動作"
          description={imported ? '此紀錄不能改變類型' : undefined}
          value={form.trade_type}
          onChange={(v) => change('trade_type', v ?? 'buy')}
          data={[
            { value: 'buy', label: '買進' },
            { value: 'sell', label: '賣出' },
            ...(allowAdjust || initialTrade
              ? [
                  { value: 'stock_dividend', label: '配股（成本不變）' },
                  { value: 'adjust', label: '股數／成本調整' },
                ]
              : []),
          ]}
          disabled={busy || imported}
        />
        <TextInput
          label="交易日期"
          type="date"
          value={form.trade_date}
          onChange={(e) => change('trade_date', e.currentTarget.value)}
          disabled={busy}
        />
        <TextInput
          label="同日順序（空白置於最後）"
          inputMode="numeric"
          value={form.sequence}
          onChange={(e) => change('sequence', e.currentTarget.value)}
          disabled={busy}
        />
        {form.trade_type === 'adjust' ? (
          <>
            <TextInput
              label="調整後總股數"
              inputMode="numeric"
              value={form.quantity_after}
              onChange={(e) => change('quantity_after', e.currentTarget.value)}
              disabled={busy}
            />
            <Select
              label="成本處理"
              data={[
                { value: 'keep', label: '保持成本' },
                { value: 'set_cost', label: '指定新成本' },
                { value: 'cash_return', label: '現金退還' },
              ]}
              value={form.cost_mode}
              onChange={(v) => change('cost_mode', v ?? 'keep')}
              disabled={busy}
            />
            {form.cost_mode === 'set_cost' && (
              <TextInput
                label="調整後成本"
                inputMode="decimal"
                value={form.cost_after}
                onChange={(e) => change('cost_after', e.currentTarget.value)}
                disabled={busy}
              />
            )}{' '}
            {form.cost_mode === 'cash_return' && (
              <TextInput
                label="退還現金"
                inputMode="decimal"
                value={form.cash_amount}
                onChange={(e) => change('cash_amount', e.currentTarget.value)}
                disabled={busy}
              />
            )}
          </>
        ) : (
          <TextInput
            label="股數"
            inputMode="numeric"
            value={form.quantity}
            onChange={(e) => change('quantity', e.currentTarget.value)}
            disabled={busy}
          />
        )}
        {['buy', 'sell'].includes(form.trade_type) && (
          <>
            <TextInput
              label="成交價格"
              inputMode="decimal"
              value={form.price}
              onChange={(e) => change('price', e.currentTarget.value)}
              disabled={busy}
            />
            <TextInput
              label="手續費"
              inputMode="decimal"
              value={form.fee}
              onChange={(e) => change('fee', e.currentTarget.value)}
              disabled={busy}
            />
            <TextInput
              label="證交稅"
              inputMode="decimal"
              value={form.tax}
              onChange={(e) => change('tax', e.currentTarget.value)}
              disabled={busy}
            />
          </>
        )}
        {(form.trade_type === 'buy' ||
          form.trade_type === 'sell' ||
          form.cost_mode === 'cash_return') && (
          <ItemPicker
            items={items}
            label="交割帳戶"
            value={form.settlement_item_id}
            onChange={(v) => change('settlement_item_id', v)}
            data={options('asset')}
            searchable
            disabled={busy}
          />
        )}
        {['buy', 'sell'].includes(form.trade_type) && (
          <ItemPicker
            items={items}
            label="投資費用科目（業外支出）"
            value={form.expense_item_id}
            onChange={(v) => change('expense_item_id', v)}
            data={options('expense')}
            searchable
            disabled={busy}
          />
        )}
        {(form.trade_type === 'sell' ||
          (form.trade_type === 'adjust' && form.cost_mode !== 'keep')) && (
          <ItemPicker
            items={items}
            label="投資損益科目（業外收入）"
            value={form.gain_item_id}
            onChange={(v) => change('gain_item_id', v)}
            data={options('income')}
            searchable
            disabled={busy}
          />
        )}
        <Textarea
          label="備註"
          value={form.note}
          onChange={(e) => change('note', e.currentTarget.value)}
          disabled={busy}
        />
        <Text size="sm">
          成交價金先 HALF_UP 至 2 位；手續費併入買進成本。所有金額均為新臺幣。
        </Text>
        <Button
          variant="light"
          onClick={() => void trial()}
          disabled={busy || !security}
        >
          預覽股票分錄
        </Button>
        {preview && (
          <section className="panel" aria-label="股票分錄預覽">
            <h4>分錄預覽</h4>
            {preview.entries.length ? (
              preview.entries.map((e, i) => (
                <p key={i}>
                  {items.find((v) => v.id === e.item_id)?.name ?? '科目'}{' '}
                  <strong className="money">
                    {formatMoney(e.base_amount, 'TWD')}
                  </strong>
                </p>
              ))
            ) : (
              <p>此動作不產生帳務分錄。</p>
            )}
            {preview.position && (
              <>
                <p>
                  異動後股數 {preview.position.quantity_after}・成本{' '}
                  {formatMoney(preview.position.cost_after)}
                </p>
                <p>平均成本 {formatRate(preview.position.average_cost)}</p>
              </>
            )}
            {preview.recalculations.length > 0 && (
              <div style={{ color: 'var(--warn)' }}>
                <p>
                  將重算 {preview.recalculations.length} 筆後續紀錄，需確認。
                </p>
                {preview.recalculations.map((r, i) => (
                  <p key={i}>
                    {r.trade_date}：損益 {formatMoney(r.old_gain)} →{' '}
                    {formatMoney(r.new_gain)}
                  </p>
                ))}
              </div>
            )}
          </section>
        )}
        <Group>
          <Button
            disabled={!preview || busy}
            loading={busy}
            onClick={() => {
              if (!preview) return;
              if (preview.recalculations.length) setConfirm('save');
              else void save(preview);
            }}
          >
            儲存股票紀錄
          </Button>
          <Button variant="subtle" onClick={onClose} disabled={busy}>
            取消
          </Button>
          {initialTrade && (
            <Button
              color="red"
              variant="subtle"
              disabled={busy}
              onClick={() => void trial(true)}
            >
              刪除股票紀錄
            </Button>
          )}
        </Group>
        <ConfirmDialog
          opened={!!confirm}
          title={confirm === 'delete' ? '刪除股票紀錄' : '確認回溯重算'}
          confirmLabel={
            confirm === 'delete' ? '確認刪除並重算' : '確認重算並儲存'
          }
          onCancel={() => {
            setConfirm(null);
            setPreview(null);
          }}
          onConfirm={() => {
            if (preview) void save(preview, confirm === 'delete');
          }}
          busy={busy}
        >
          <Text>
            後續成本與投資損益將在同一個 transaction
            內重算；交割與費用分錄保持不變。
          </Text>
          {preview?.recalculations.map((r, i) => (
            <Text key={i}>
              {r.trade_date}：{formatMoney(r.old_gain)} →{' '}
              {formatMoney(r.new_gain)}
            </Text>
          ))}
        </ConfirmDialog>
      </Stack>
    </EdgeScroll>
  );
}
