// SPDX-License-Identifier: AGPL-3.0-only
import { ItemPicker } from './design/item-picker';
import { useEffect, useState, useRef } from 'react';
import {
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import type { DividendInput } from '@finmichi/core/dividend-schemas';
import type { Item } from '@finmichi/core/catalog-schemas';
import {
  stockFixed,
  stockUnits,
  stockDivide,
} from '@finmichi/core/securities-math';
import { api, errorMessage } from './api';
import { AdminEditor } from './design/admin-editor';
import { ConfirmDialog, ErrorState, notify } from './design/feedback';
import { formatMoney } from './design/format';
import { guardNavigation } from './design/location';
export type DividendRecord = DividendInput & {
  id: string;
  transaction_id: string | null;
  stock_trade_id: string | null;
};
export interface DividendCode {
  id: string;
  code: string;
  label: string;
  income_item_id: string | null;
}
interface Preview {
  preview_hash: string;
  entries: { item_id: string; base_amount: string }[];
  recalculations: { trade_date: string; old_gain: string; new_gain: string }[];
}
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(
    new Date(),
  );
export function DividendEntry({
  ledger,
  securities,
  items,
  codes,
  defaults,
  initial,
  security,
  onClose,
  onSaved,
}: {
  ledger: string;
  securities: { id: string; name: string }[];
  items: Item[];
  codes: DividendCode[];
  defaults: Partial<DividendInput>;
  initial: DividendRecord | null;
  security?: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<DividendInput>(() =>
    initial
      ? {
          ...initial,
          components: initial.components.map((c) => ({
            code: c.code,
            label: c.label,
            amount: c.amount,
            taxable: c.taxable,
          })),
        }
      : {
          security_id: security ?? securities[0]?.id ?? '',
          ex_date: today(),
          pay_date: today(),
          per_share: '0',
          shares: '0',
          gross_amount: '0',
          withholding_tax: '0',
          nhi_premium: '0',
          fee: '0',
          net_amount: '0',
          stock_shares: '0',
          source_document: null,
          note: '',
          settlement_item_id: null,
          default_income_item_id: codes[0]?.income_item_id ?? null,
          tax_item_id: null,
          expense_item_id: null,
          components: [],
          ...defaults,
        },
  );
  const [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(''),
    [discard, setDiscard] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const base = `/api/ledgers/${ledger}`;
  const change = (patch: Partial<DividendInput>) => {
    setD((v) => ({ ...v, ...patch }));
    setPreview(null);
    setConfirmed(false);
    setDirty(true);
  };
  const close = () => {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const pendingNavigation = useRef<null | (() => void)>(null);
  useEffect(
    () =>
      guardNavigation((proceed) => {
        if (busy) return;
        if (dirty) {
          pendingNavigation.current = proceed;
          setDiscard(true);
        } else proceed();
      }),
    [dirty, busy],
  );

  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [dirty]);
  useEffect(() => {
    if (initial || !d.security_id || !d.ex_date) return;
    let live = true;
    void api<{ shares: string }>(
      base +
        `/securities/${d.security_id}/dividend-shares?ex_date=${encodeURIComponent(d.ex_date)}`,
    )
      .then((r) => {
        if (live) setD((v) => ({ ...v, shares: r.shares }));
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [base, d.security_id, d.ex_date, initial]);
  const body = () => {
    const {
      ledger_id: _ledger,
      id: _,
      transaction_id: __,
      stock_trade_id: ___,
      ...known
    } = d as DividendRecord & { ledger_id?: string };
    void _ledger;
    void _;
    void __;
    void ___;
    return known;
  };
  async function runPreview() {
    setBusy(true);
    setError('');
    try {
      setPreview(
        await api<Preview>(base + '/dividend-preview', 'POST', {
          operation: initial ? 'update' : 'create',
          ...(initial ? { id: initial.id } : {}),
          dividend: body(),
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await api(
        base + '/dividends' + (initial ? '/' + initial.id : ''),
        initial ? 'PUT' : 'POST',
        {
          dividend: body(),
          preview_hash: preview.preview_hash,
          confirm_recalculation: confirmed,
        },
      );
      setDirty(false);
      notify('股利已儲存');
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const options = (kind: Item['kind']) =>
    items
      .filter(
        (i) =>
          i.kind === kind &&
          i.currency === 'TWD' &&
          !i.securities &&
          (!i.archived ||
            [
              initial?.settlement_item_id,
              initial?.default_income_item_id,
              initial?.tax_item_id,
              initial?.expense_item_id,
            ].includes(i.id)),
      )
      .map((i) => ({ value: i.id, label: i.name }));
  const component = (
    i: number,
    patch: Partial<DividendInput['components'][number]>,
  ) =>
    change({
      components: d.components.map((c, k) =>
        k === i ? { ...c, ...patch } : c,
      ),
    });
  return (
    <>
      <AdminEditor
        opened
        title={initial ? '編輯股利' : '新增股利'}
        desktopSize={600}
        onClose={close}
        busy={busy}
      >
        <fieldset
          disabled={busy}
          style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
        >
          <Stack>
            <Text size="sm">
              代碼與名稱以集保結算所／發行機構通知為準。配股於發放日加入；參與股數採除息日前持股，可手動修改。
            </Text>
            <Select
              label="股利股票"
              data={securities.map((s) => ({ value: s.id, label: s.name }))}
              value={d.security_id}
              disabled={!!initial || busy}
              onChange={(v) => change({ security_id: v ?? '' })}
            />
            <Group grow>
              <TextInput
                label="除權息日"
                type="date"
                value={d.ex_date}
                onChange={(e) => change({ ex_date: e.currentTarget.value })}
              />
              <TextInput
                label="發放日"
                aria-label="發放日"
                required
                type="date"
                value={d.pay_date}
                onChange={(e) => change({ pay_date: e.currentTarget.value })}
              />
            </Group>
            <TextInput
              label="參與股數"
              inputMode="numeric"
              value={d.shares}
              onChange={(e) => change({ shares: e.currentTarget.value })}
            />
            <TextInput
              label="每股配息"
              inputMode="decimal"
              value={d.per_share}
              onChange={(e) => change({ per_share: e.currentTarget.value })}
            />
            <Button
              variant="light"
              disabled={busy}
              onClick={() => {
                try {
                  change({
                    gross_amount: stockFixed(
                      stockDivide(
                        BigInt(d.shares) * stockUnits(d.per_share, 8),
                        1000000n,
                      ),
                    ),
                  });
                } catch {
                  setError('請輸入有效的股數與每股配息');
                }
              }}
            >
              依股數計算應發
            </Button>
            {(
              [
                'gross_amount',
                'withholding_tax',
                'nhi_premium',
                'fee',
                'net_amount',
                'stock_shares',
              ] as const
            ).map((k, i) => (
              <TextInput
                key={k}
                label={
                  [
                    '應發總額',
                    '扣繳稅額',
                    '二代健保補充保費',
                    '匯費',
                    '實發金額',
                    '同次配股股數',
                  ][i]
                }
                inputMode="decimal"
                value={d[k]}
                onChange={(e) => change({ [k]: e.currentTarget.value })}
              />
            ))}
            <Button
              variant="light"
              disabled={busy}
              onClick={() => {
                try {
                  change({
                    net_amount: stockFixed(
                      stockUnits(d.gross_amount) -
                        stockUnits(d.withholding_tax) -
                        stockUnits(d.nhi_premium) -
                        stockUnits(d.fee),
                    ),
                  });
                } catch {
                  setError('請輸入有效金額');
                }
              }}
            >
              計算實發
            </Button>
            <ItemPicker
              items={items}
              label="交割帳戶"
              data={options('asset')}
              value={d.settlement_item_id}
              onChange={(v) => change({ settlement_item_id: v })}
              clearable
            />
            <ItemPicker
              items={items}
              label="預設股利收入科目"
              data={options('income')}
              value={d.default_income_item_id}
              onChange={(v) => change({ default_income_item_id: v })}
              clearable
            />
            <ItemPicker
              items={items}
              label="稅費科目"
              data={options('expense')}
              value={d.tax_item_id}
              onChange={(v) => change({ tax_item_id: v })}
              clearable
            />
            <ItemPicker
              items={items}
              label="投資費用科目"
              data={options('expense')}
              value={d.expense_item_id}
              onChange={(v) => change({ expense_item_id: v })}
              clearable
            />
            <h3>所得組成</h3>
            {d.components.map((c, i) => (
              <section className="panel" key={i}>
                <Stack gap="xs">
                  <TextInput
                    label={`組成 ${i + 1} 代碼`}
                    value={c.code}
                    onChange={(e) => {
                      const v = e.currentTarget.value,
                        code = codes.find((c) => c.code === v);
                      component(i, {
                        code: v,
                        ...(code ? { label: code.label } : {}),
                      });
                    }}
                  />
                  <TextInput
                    label={`組成 ${i + 1} 名稱`}
                    value={c.label}
                    onChange={(e) =>
                      component(i, { label: e.currentTarget.value })
                    }
                  />
                  <TextInput
                    label={`組成 ${i + 1} 金額`}
                    inputMode="decimal"
                    value={c.amount}
                    onChange={(e) =>
                      component(i, { amount: e.currentTarget.value })
                    }
                  />
                  <Checkbox
                    label={`組成 ${i + 1} 應稅（依通知自行確認）`}
                    checked={c.taxable}
                    onChange={(e) =>
                      component(i, { taxable: e.currentTarget.checked })
                    }
                  />
                  <Text size="xs">
                    收入科目：
                    {items.find(
                      (x) =>
                        x.id ===
                        (codes.find((x) => x.code === c.code)?.income_item_id ??
                          d.default_income_item_id),
                    )?.name ?? '尚未設定'}
                  </Text>
                  <Button
                    variant="subtle"
                    onClick={() =>
                      change({
                        components: d.components.filter((_, k) => k !== i),
                      })
                    }
                  >
                    移除組成 {i + 1}
                  </Button>
                </Stack>
              </section>
            ))}
            <Button
              variant="light"
              onClick={() =>
                change({
                  components: [
                    ...d.components,
                    {
                      code: codes[0]?.code ?? '',
                      label: codes[0]?.label ?? '',
                      amount: '0',
                      taxable: false,
                    },
                  ],
                })
              }
            >
              新增組成
            </Button>
            <details>
              <summary>來源文件識別（不儲存檔案）</summary>
              <Stack>
                <TextInput
                  label="來源檔名"
                  value={d.source_document?.filename ?? ''}
                  onChange={(e) =>
                    change({
                      source_document: {
                        filename: e.currentTarget.value,
                        sha256: d.source_document?.sha256 ?? '',
                        page: d.source_document?.page ?? 1,
                      },
                    })
                  }
                />
                <TextInput
                  label="來源 SHA-256"
                  value={d.source_document?.sha256 ?? ''}
                  onChange={(e) =>
                    change({
                      source_document: {
                        filename: d.source_document?.filename ?? '',
                        sha256: e.currentTarget.value,
                        page: d.source_document?.page ?? 1,
                      },
                    })
                  }
                />
                <TextInput
                  label="來源頁碼"
                  inputMode="numeric"
                  value={String(d.source_document?.page ?? 1)}
                  onChange={(e) =>
                    change({
                      source_document: {
                        filename: d.source_document?.filename ?? '',
                        sha256: d.source_document?.sha256 ?? '',
                        page: Number(e.currentTarget.value),
                      },
                    })
                  }
                />
                <Button
                  variant="subtle"
                  onClick={() => change({ source_document: null })}
                >
                  清除來源識別
                </Button>
              </Stack>
            </details>
            <Textarea
              label="股利備註"
              value={d.note}
              onChange={(e) => change({ note: e.currentTarget.value })}
            />
            {error && (
              <ErrorState message={error} retry={() => void runPreview()} />
            )}
            <Button
              variant="light"
              disabled={busy}
              onClick={() => void runPreview()}
            >
              預覽股利分錄
            </Button>
            {preview && (
              <section className="panel" data-testid="dividend-preview">
                <h3>分錄預覽</h3>
                {preview.entries.length ? (
                  preview.entries.map((e, i) => (
                    <p key={i}>
                      {items.find((x) => x.id === e.item_id)?.name}{' '}
                      <span className="money">
                        {formatMoney(e.base_amount)}
                      </span>
                    </p>
                  ))
                ) : (
                  <Text>純配股，不產生現金交易</Text>
                )}
                {preview.recalculations.map((r, i) => (
                  <Text key={i}>
                    {r.trade_date} 損益 {formatMoney(r.old_gain)} →{' '}
                    {formatMoney(r.new_gain)}
                  </Text>
                ))}
                {preview.recalculations.length > 0 && (
                  <Checkbox
                    label="我已確認後續賣出成本與損益重算"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.currentTarget.checked)}
                  />
                )}
              </section>
            )}
            <Button
              disabled={
                busy ||
                !preview ||
                (preview.recalculations.length > 0 && !confirmed)
              }
              onClick={() => void save()}
            >
              儲存股利
            </Button>
          </Stack>
        </fieldset>
      </AdminEditor>
      <ConfirmDialog
        opened={discard}
        title="放棄未儲存的股利？"
        confirmLabel="放棄內容"
        onCancel={() => setDiscard(false)}
        onConfirm={() => {
          setDirty(false);
          setDiscard(false);
          onClose();
          const go = pendingNavigation.current;
          pendingNavigation.current = null;
          go?.();
        }}
        busy={busy}
      >
        尚未儲存的內容將會清除。
      </ConfirmDialog>
    </>
  );
}
