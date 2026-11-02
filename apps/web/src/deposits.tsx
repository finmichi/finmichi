// SPDX-License-Identifier: AGPL-3.0-only
import { ItemPicker } from './design/item-picker';
import { useState, useEffect, useCallback, useRef } from 'react';
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
import type { Ledger, Item } from '@finmichi/core/catalog-schemas';
import type {
  DepositInput,
  DepositAmounts,
} from '@finmichi/core/deposit-schemas';
import type { DepositReport } from '@finmichi/core';
import { monthDate } from '@finmichi/core/finance-calendar';
import { api, errorMessage } from './api';
import { formatMoney, formatPercent, formatRate } from './design/format';
import { AdminEditor } from './design/admin-editor';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  notify,
} from './design/feedback';
import { guardNavigation, openPaymentEntry } from './design/location';
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(
    new Date(),
  );
type Row = DepositReport['deposits'][number];
type Preview = {
  preview_hash: string;
  entries: {
    item_id: string;
    amount: string;
    currency: string;
    exchange_rate: string;
    base_amount: string;
  }[];
  renewal: DepositInput | null;
  creates_transaction: boolean;
};
export function Deposits({ ledger }: { ledger: Ledger }) {
  const base = `/api/ledgers/${ledger.id}/deposits`;
  const [report, setReport] = useState<DepositReport | null>(null),
    [items, setItems] = useState<Item[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [closed, setClosed] = useState(false);
  const [edit, setEdit] = useState<Row | null | undefined>(undefined),
    [post, setPost] = useState<{
      d: Row;
      kind: 'interest' | 'settlement';
      period?: number;
    } | null>(null),
    [remove, setRemove] = useState<Row | null>(null),
    [undo, setUndo] = useState<{ d: Row; id: string; hash: string } | null>(
      null,
    ),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setError('');
    try {
      const [r, is] = await Promise.all([
        api<DepositReport>(base),
        api<Item[]>(`/api/ledgers/${ledger.id}/items?include_archived=true`),
      ]);
      setReport(r);
      setItems(is);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [base, ledger.id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (loading) return <LoadingState label="載入定存" />;
  const rows =
    report?.deposits.filter((d) => closed || d.status === 'active') ?? [];
  return (
    <Stack>
      <Group justify="space-between">
        <h1>定存</h1>
        <Button onClick={() => setEdit(null)}>新增定存</Button>
      </Group>
      {error && <ErrorState message={error} retry={() => void refresh()} />}
      {report && (
        <section className="deposit-totals" aria-label="定存合計">
          <div>
            存續本金
            <strong>
              {formatMoney(
                report.totals.active_principal,
                ledger.base_currency,
              )}
            </strong>
          </div>
          <div>
            整期預估利息
            <strong>
              {formatMoney(
                report.totals.estimated_interest,
                ledger.base_currency,
              )}
            </strong>
          </div>
        </section>
      )}
      {!!report?.totals.missing_market_rates && (
        <Text style={{ color: 'var(--warn)' }}>
          部分外幣無行情，未計入本位幣合計。
        </Text>
      )}
      <Text size="sm" c="dimmed">
        利息試算只作預填，請依銀行實際金額確認；扣繳與補充保費不自動判斷。
      </Text>
      <Checkbox
        label="顯示已到期／已解約"
        checked={closed}
        onChange={(e) => setClosed(e.currentTarget.checked)}
      />
      {!rows.length ? (
        <EmptyState title="尚無存續中的定存">
          新增設定不會自動入帳；既有餘額可以只建立設定。
        </EmptyState>
      ) : (
        <div className="deposit-grid">
          {rows.map((d) => (
            <article className="deposit-card" key={d.id}>
              <Group justify="space-between">
                <h2>{d.bank}</h2>
                <Text>
                  {d.status === 'active'
                    ? '存續中'
                    : d.status === 'matured'
                      ? '已到期'
                      : '已解約'}
                </Text>
              </Group>
              <Text>
                {d.item_name} · {d.currency}
              </Text>
              <strong className="money">
                {formatMoney(d.principal, d.currency)}
              </strong>
              <Text>
                年利率 {formatPercent(d.annual_rate)} · {d.start_on} →{' '}
                {d.maturity_on}
              </Text>
              <Text>
                {d.status === 'active' && d.remaining_days < 0 ? (
                  <span className="finance-warning">
                    已到期 {-d.remaining_days} 天，待處理
                  </span>
                ) : (
                  <>剩餘 {d.remaining_days} 天</>
                )}{' '}
                · {d.interest_basis === 'monthly' ? '按月計息' : '按日計息'} ·{' '}
                {d.payout === 'monthly' ? '按月付息' : '到期付息'}
              </Text>
              <Text>
                整期試算 {formatMoney(d.total_interest, d.currency)} · 已入帳{' '}
                {formatMoney(d.posted_interest, d.currency)}
              </Text>
              {d.currency !== ledger.base_currency && (
                <Text size="sm" c="dimmed">
                  {d.valuation
                    ? `行情日期 ${d.valuation.rate_date} · 匯率 ${formatRate(d.valuation.rate)}`
                    : '無市場匯率，未計入合計'}
                </Text>
              )}
              <Group>
                <Button variant="light" onClick={() => setEdit(d)}>
                  編輯
                </Button>
                <Button
                  variant="light"
                  onClick={() =>
                    openPaymentEntry(
                      ledger.id,
                      {
                        occurred_on: today(),
                        memo: d.note,
                        payee_id: null,
                        project_id: null,
                        invoice_no: '',
                        entries: [
                          {
                            item_id: d.payout_account_id,
                            amount: '-' + d.principal,
                          },
                          { item_id: d.item_id, amount: d.principal },
                        ],
                      },
                      'transfer',
                    )
                  }
                >
                  建立轉存交易
                </Button>
                {d.status === 'active' && (
                  <Button onClick={() => setPost({ d, kind: 'settlement' })}>
                    到期處理
                  </Button>
                )}
                <Button
                  variant="subtle"
                  disabled={d.postings.length > 0}
                  onClick={() => setRemove(d)}
                >
                  刪除設定
                </Button>
              </Group>
              <details>
                <summary>付息排程與入帳紀錄</summary>
                <Stack gap="xs">
                  {d.schedule.map((p) => (
                    <div className="deposit-period" key={p.period_no}>
                      <Text>
                        第 {p.period_no} 期 · {p.due_on} ·{' '}
                        {formatMoney(p.interest, d.currency)} ·{' '}
                        {p.posted ? '已處理' : '未處理'}
                      </Text>
                      {d.payout === 'monthly' &&
                        d.status === 'active' &&
                        !p.posted && (
                          <Button
                            size="compact-md"
                            aria-label={`入帳 ${d.bank} 第 ${p.period_no} 期`}
                            onClick={() =>
                              setPost({
                                d,
                                kind: 'interest',
                                period: p.period_no,
                              })
                            }
                          >
                            入帳
                          </Button>
                        )}
                    </div>
                  ))}
                  {d.postings.map((p) => (
                    <Group key={p.id}>
                      <Text>
                        {p.posted_on} ·{' '}
                        {p.kind === 'interest'
                          ? `第 ${p.period_no} 期`
                          : '結清／續存'}{' '}
                        · {formatMoney(p.gross_interest, d.currency)}
                        {!p.transaction_id ? '（零額，無交易）' : ''}
                      </Text>
                      {(d.status === 'active' || p.kind === 'settlement') && (
                        <Button
                          variant="subtle"
                          disabled={busy}
                          onClick={() => {
                            setBusy(true);
                            void api<Preview>(
                              base + `/${d.id}/preview`,
                              'POST',
                              {
                                operation: 'revoke',
                                posting_id: p.id,
                              },
                            )
                              .then((v) =>
                                setUndo({ d, id: p.id, hash: v.preview_hash }),
                              )
                              .catch((e) => setError(errorMessage(e)))
                              .finally(() => setBusy(false));
                          }}
                        >
                          撤銷入帳
                        </Button>
                      )}
                    </Group>
                  ))}
                </Stack>
              </details>
            </article>
          ))}
        </div>
      )}
      {edit !== undefined && (
        <DepositEditor
          key={edit?.id ?? 'new'}
          initial={edit}
          items={items}
          baseCurrency={ledger.base_currency}
          onClose={() => setEdit(undefined)}
          onSave={async (d) => {
            await api(
              base + (edit ? '/' + edit.id : ''),
              edit ? 'PUT' : 'POST',
              d,
            );
            setEdit(undefined);
            notify('定存設定已儲存');
            await refresh();
          }}
        />
      )}
      {post && (
        <PostingEditor
          data={post}
          items={items}
          baseCurrency={ledger.base_currency}
          base={base}
          onClose={() => setPost(null)}
          onSaved={() => {
            setPost(null);
            notify('定存已處理');
            void refresh();
          }}
        />
      )}
      <ConfirmDialog
        opened={!!remove || !!undo}
        title={undo ? '撤銷定存入帳' : '刪除定存設定'}
        confirmLabel={undo ? '撤銷入帳' : '刪除設定'}
        onCancel={() => {
          setRemove(null);
          setUndo(null);
        }}
        busy={busy}
        onConfirm={() => {
          setBusy(true);
          const url = undo
            ? `${base}/${undo.d.id}/postings/${undo.id}`
            : `${base}/${remove!.id}`;
          void api(
            url,
            'DELETE',
            undo ? { preview_hash: undo.hash } : undefined,
          )
            .then(() => {
              setUndo(null);
              setRemove(null);
              notify('定存資料已更新');
              return refresh();
            })
            .catch((e) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        <Text>
          {undo
            ? '將刪除該次入帳交易；若是續存，會一併刪除尚未入帳的下一期設定。'
            : '刪除設定不會刪除自行建立的轉存交易。'}
        </Text>
      </ConfirmDialog>
    </Stack>
  );
}
function useDirty(close: () => void, busy: boolean) {
  const [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false),
    pending = useRef<null | (() => void)>(null);
  const request = () => {
    if (busy) return;
    if (dirty) setDiscard(true);
    else close();
  };
  useEffect(
    () =>
      guardNavigation((go) => {
        if (busy) return;
        if (dirty) {
          pending.current = go;
          setDiscard(true);
        } else go();
      }),
    [busy, dirty],
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
  return {
    setDirty,
    request,
    dialog: (
      <ConfirmDialog
        opened={discard}
        title="捨棄未儲存變更"
        confirmLabel="捨棄變更"
        onCancel={() => setDiscard(false)}
        onConfirm={() => {
          setDirty(false);
          setDiscard(false);
          close();
          pending.current?.();
        }}
      >
        <Text>尚有未儲存內容，確定要離開嗎？</Text>
      </ConfirmDialog>
    ),
  };
}
function DepositEditor({
  initial,
  items,
  baseCurrency,
  onClose,
  onSave,
}: {
  initial: Row | null;
  items: Item[];
  baseCurrency: string;
  onClose: () => void;
  onSave: (d: DepositInput) => Promise<void>;
}) {
  const [d, setD] = useState<DepositInput>(() =>
    initial
      ? (Object.fromEntries(
          [
            'item_id',
            'bank',
            'principal',
            'annual_rate',
            'start_on',
            'maturity_on',
            'interest_basis',
            'payout',
            'auto_renew',
            'payout_account_id',
            'interest_item_id',
            'note',
          ].map((k) => [k, initial[k as keyof Row]]),
        ) as DepositInput)
      : {
          item_id: '',
          bank: '',
          principal: '',
          annual_rate: '0',
          start_on: today(),
          maturity_on: monthDate(today(), 12),
          interest_basis: 'monthly',
          payout: 'at_maturity',
          auto_renew: false,
          payout_account_id: '',
          interest_item_id:
            items.find(
              (i) =>
                i.kind === 'income' &&
                i.currency === baseCurrency &&
                i.non_operating &&
                !i.archived,
            )?.id ?? '',
          note: '',
        },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const guard = useDirty(onClose, busy),
    locked = !!initial?.postings.length;
  const change = (patch: Partial<DepositInput>) => {
    setD((v) => ({ ...v, ...patch }));
    guard.setDirty(true);
  };
  const choices = (kind: string) =>
    items
      .filter((i) => i.kind === kind)
      .map((i) => ({
        value: i.id,
        label: `${i.name} (${i.currency})`,
        disabled:
          i.archived ||
          i.securities ||
          (kind === 'asset' && (i.credit_card || i.loan)) ||
          (kind === 'income' && i.currency !== baseCurrency),
      }));
  return (
    <>
      <AdminEditor
        opened
        busy={busy}
        title={initial ? '編輯定存' : '新增定存'}
        onClose={guard.request}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void onSave(d)
              .catch((e) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          <Stack>
            {error && <ErrorState message={error} />}
            <TextInput
              label="銀行"
              value={d.bank}
              onChange={(e) => change({ bank: e.currentTarget.value })}
              required
            />
            <ItemPicker
              items={items}
              label="定存科目"
              data={choices('asset')}
              value={d.item_id || null}
              onChange={(v) => change({ item_id: v ?? '' })}
              disabled={locked}
              required
            />
            <ItemPicker
              items={items}
              label="撥入帳戶"
              data={choices('asset')}
              value={d.payout_account_id || null}
              onChange={(v) => change({ payout_account_id: v ?? '' })}
              disabled={locked}
              required
            />
            <ItemPicker
              items={items}
              label="利息收入科目（本位幣）"
              data={choices('income')}
              value={d.interest_item_id || null}
              onChange={(v) => change({ interest_item_id: v ?? '' })}
              disabled={locked}
              required
            />
            <TextInput
              label="本金"
              inputMode="decimal"
              value={d.principal}
              onChange={(e) => change({ principal: e.currentTarget.value })}
              disabled={locked}
              required
            />
            <TextInput
              label="年利率（%）"
              inputMode="decimal"
              value={d.annual_rate}
              onChange={(e) => change({ annual_rate: e.currentTarget.value })}
              disabled={locked}
              required
            />
            <TextInput
              label="起存日"
              type="date"
              value={d.start_on}
              onChange={(e) => change({ start_on: e.currentTarget.value })}
              disabled={locked}
              required
            />
            <TextInput
              label="到期日"
              type="date"
              value={d.maturity_on}
              onChange={(e) => change({ maturity_on: e.currentTarget.value })}
              disabled={locked}
              required
            />
            <Select
              label="計息方式"
              data={[
                { value: 'monthly', label: '按月計息' },
                { value: 'daily', label: '按日計息（365天）' },
              ]}
              value={d.interest_basis}
              onChange={(v) =>
                change({ interest_basis: v as DepositInput['interest_basis'] })
              }
              disabled={locked}
            />
            <Select
              label="付息方式"
              data={[
                { value: 'at_maturity', label: '到期付息' },
                { value: 'monthly', label: '按月付息' },
              ]}
              value={d.payout}
              onChange={(v) => change({ payout: v as DepositInput['payout'] })}
              disabled={locked}
            />
            <Checkbox
              label="到期處理預設續存本金"
              checked={d.auto_renew}
              onChange={(e) => change({ auto_renew: e.currentTarget.checked })}
              disabled={locked}
            />
            <Textarea
              label="備註"
              value={d.note}
              onChange={(e) => change({ note: e.currentTarget.value })}
            />
            <Text size="sm" c="dimmed">
              {locked
                ? '已有入帳紀錄，只能修改銀行與備註。'
                : '建立設定不會自動入帳；儲存後可建立轉存交易。'}
            </Text>
            <Button type="submit" loading={busy}>
              儲存設定
            </Button>
          </Stack>
        </form>
      </AdminEditor>
      {guard.dialog}
    </>
  );
}
function PostingEditor({
  data,
  items,
  baseCurrency,
  base,
  onClose,
  onSaved,
}: {
  data: { d: Row; kind: 'interest' | 'settlement'; period?: number };
  items: Item[];
  baseCurrency: string;
  base: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { d, kind, period } = data,
    p = d.schedule.find(
      (x) => x.period_no === (period ?? d.schedule.at(-1)!.period_no),
    )!;
  const [a, setA] = useState<DepositAmounts>({
      ...(kind === 'interest' ? { period_no: period } : {}),
      posted_on: p.due_on,
      gross_interest: p.posted ? '0' : p.interest,
      withholding_tax: '0',
      nhi_premium: '0',
      tax_item_id:
        items.find(
          (i) =>
            i.kind === 'expense' &&
            i.currency === baseCurrency &&
            i.name === '稅費',
        )?.id ?? null,
      renew: kind === 'settlement' && d.auto_renew ? 'principal' : 'none',
    }),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const guard = useDirty(onClose, busy),
    change = (patch: Partial<DepositAmounts>) => {
      setA((v) => ({ ...v, ...patch }));
      setPreview(null);
      guard.setDirty(true);
    };
  return (
    <>
      <AdminEditor
        opened
        busy={busy}
        title={
          kind === 'interest'
            ? `定存付息 ${d.bank} 第 ${period} 期`
            : `到期處理 ${d.bank}`
        }
        onClose={guard.request}
      >
        <Stack>
          {error && <ErrorState message={error} />}
          <Text>
            {d.currency} · 試算 {formatMoney(p.interest, d.currency)}
            ，請核對銀行實際金額。
          </Text>
          <TextInput
            label="入帳日"
            type="date"
            value={a.posted_on}
            onChange={(e) => change({ posted_on: e.currentTarget.value })}
          />
          <TextInput
            label="應發利息"
            inputMode="decimal"
            value={a.gross_interest}
            onChange={(e) => change({ gross_interest: e.currentTarget.value })}
          />
          <TextInput
            label="扣繳"
            inputMode="decimal"
            value={a.withholding_tax}
            onChange={(e) => change({ withholding_tax: e.currentTarget.value })}
          />
          <TextInput
            label="補充保費"
            inputMode="decimal"
            value={a.nhi_premium}
            onChange={(e) => change({ nhi_premium: e.currentTarget.value })}
          />
          <ItemPicker
            items={items}
            label="稅費科目"
            clearable
            data={items
              .filter(
                (i) =>
                  i.kind === 'expense' &&
                  i.currency === baseCurrency &&
                  !i.archived,
              )
              .map((i) => ({ value: i.id, label: i.name }))}
            value={a.tax_item_id}
            onChange={(v) => change({ tax_item_id: v })}
          />
          {d.currency !== baseCurrency && (
            <TextInput
              label="匯率（留空使用參考匯率）"
              inputMode="decimal"
              value={a.exchange_rate ?? ''}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setA((old) => {
                  const next = { ...old };
                  if (v) next.exchange_rate = v;
                  else delete next.exchange_rate;
                  return next;
                });
                setPreview(null);
                guard.setDirty(true);
              }}
            />
          )}
          {kind === 'settlement' && (
            <Select
              label="到期處理方式"
              value={a.renew}
              data={[
                { value: 'none', label: '領回本金與利息' },
                { value: 'principal', label: '續存本金，領取利息' },
                {
                  value: 'principal_and_interest',
                  label: '本金與實發利息續存',
                },
              ]}
              onChange={(v) => change({ renew: v as DepositAmounts['renew'] })}
            />
          )}
          <Button
            variant="light"
            loading={busy}
            onClick={() => {
              setBusy(true);
              setError('');
              void api<Preview>(base + `/${d.id}/preview`, 'POST', {
                operation: kind,
                amounts: a,
              })
                .then(setPreview)
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            預覽分錄
          </Button>
          {preview && (
            <section aria-label="定存分錄預覽">
              <h3>分錄預覽</h3>
              {preview.entries.map((e, i) => (
                <div key={i}>
                  <Text>
                    {items.find((x) => x.id === e.item_id)?.name}{' '}
                    {formatMoney(e.amount, e.currency)}
                  </Text>
                  {e.currency !== baseCurrency && (
                    <Text size="sm" title={e.exchange_rate}>
                      匯率 {formatRate(e.exchange_rate)} ·{' '}
                      {formatMoney(e.base_amount, baseCurrency)}
                    </Text>
                  )}
                </div>
              ))}
              {!preview.creates_transaction && (
                <Text>零額處理：只記錄已處理期別，不建立交易。</Text>
              )}
              {preview.renewal && (
                <Text>
                  續存本金 {formatMoney(preview.renewal.principal, d.currency)}{' '}
                  · {preview.renewal.start_on} → {preview.renewal.maturity_on}
                </Text>
              )}
              <Button
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  void api(
                    base +
                      `/${d.id}/${kind === 'interest' ? 'interest' : 'settle'}`,
                    'POST',
                    { ...a, preview_hash: preview.preview_hash },
                  )
                    .then(onSaved)
                    .catch((e) => setError(errorMessage(e)))
                    .finally(() => setBusy(false));
                }}
              >
                確認入帳
              </Button>
            </section>
          )}
        </Stack>
      </AdminEditor>
      {guard.dialog}
    </>
  );
}
