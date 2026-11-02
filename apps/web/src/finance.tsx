// SPDX-License-Identifier: AGPL-3.0-only
import { ItemPicker } from './design/item-picker';
import { useEffect, useState } from 'react';
import { Button, Group, Stack, Select, Text, TextInput } from '@mantine/core';
import type { Item, Ledger } from '@finmichi/core/catalog-schemas';
import type { CardsResult, LoansResult } from '@finmichi/core';
import {
  validCardSchedule,
  cardSettingsSchema,
  loanSettingsSchema,
  type CardSettings,
  type LoanSettings,
} from '@finmichi/core/finance-schemas';
import { api, errorMessage } from './api';
import { AdminEditor } from './design/admin-editor';
import {
  LoadingState,
  ErrorState,
  EmptyState,
  ConfirmDialog,
  notify,
} from './design/feedback';
import { EdgeScroll } from './design/edge-scroll';
import { formatMoney, formatPercent } from './design/format';
import { todayTaipei, units } from './design/display-math';
import { guardNavigation, openPaymentEntry } from './design/location';
import {
  cardPaymentReason,
  cardNextDates,
  recentLoanPeriods,
  loanPayment,
  foreignCardPayment,
} from './finance-payments';
import { useTransactionRevision } from './design/data-revision';
const cardDefault: Omit<CardSettings, 'item_id'> = {
  statement_day: 15,
  due_day: 5,
  due_month_offset: 1,
  payment_account_id: null,
  credit_limit: null,
};
const loanDefault: Omit<LoanSettings, 'item_id'> = {
  principal: '',
  annual_rate: '',
  term_months: 240,
  first_payment_on: todayTaipei(),
  method: 'annuity',
  payment_account_id: '',
  interest_item_id: '',
};
type Form = CardSettings | LoanSettings;
export function Finance({
  ledger,
  type,
}: {
  ledger: Ledger;
  type: 'cards' | 'loans';
}) {
  const [items, setItems] = useState<Item[]>([]),
    [cards, setCards] = useState<CardsResult | null>(null),
    [loans, setLoans] = useState<LoansResult | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [form, setForm] = useState<Form | null>(null),
    [baseline, setBaseline] = useState(''),
    [discard, setDiscard] = useState<(() => void) | null>(null),
    [remove, setRemove] = useState<string | null>(null);
  const transactionRevision = useTransactionRevision(),
    base = `/api/ledgers/${ledger.id}/${type}`,
    isCard = type === 'cards',
    label = isCard ? '信用卡' : '貸款',
    dirty = form !== null && JSON.stringify(form) !== baseline;
  useEffect(
    () =>
      guardNavigation((proceed) => {
        if (busy) return;
        if (dirty) setDiscard(() => proceed);
        else proceed();
      }),
    [dirty, busy],
  );
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void Promise.all([
      api<Item[]>(`/api/ledgers/${ledger.id}/items?include_archived=true`),
      isCard ? api<CardsResult>(base) : api<LoansResult>(base),
    ])
      .then(([i, result]) => {
        if (live) {
          setItems(i);
          if ('cards' in result) setCards(result);
          else setLoans(result);
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
  }, [base, isCard, revision, transactionRevision, ledger.id]);
  const eligible = items.filter(
      (i) => i.kind === 'liability' && (isCard ? i.credit_card : i.loan),
    ),
    assets = items.filter((i) => i.kind === 'asset'),
    expenses = items.filter((i) => i.kind === 'expense');
  const names = (
    rows: Item[],
    role: 'item' | 'payment' | 'interest' = 'item',
  ) =>
    rows.map((i) => ({
      value: i.id,
      disabled: isCard
        ? role === 'payment' &&
          i.currency !== ledger.base_currency &&
          i.currency !== items.find((x) => x.id === form?.item_id)?.currency
        : i.currency !== ledger.base_currency,
      label: i.name + '（' + i.currency + '）' + (i.archived ? '・已封存' : ''),
    }));
  function edit(value: Form) {
    setForm(value);
    setBaseline(JSON.stringify(value));
    setError('');
  }
  function close() {
    if (busy) return;
    if (dirty) setDiscard(() => () => setForm(null));
    else setForm(null);
  }
  async function save() {
    const parsed = (isCard ? cardSettingsSchema : loanSettingsSchema).safeParse(
      form,
    );
    if (!parsed.success) {
      setError('請完整填寫設定，金額最多 2 位小數、年利率最多 6 位。');
      return;
    }
    if (isCard && !validCardSchedule(parsed.data as CardSettings)) {
      setError('繳款日須晚於結帳日；結帳日 28 日以後請選「次月繳款」。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(base, 'PUT', parsed.data);
      setForm(null);
      setRevision((v) => v + 1);
      notify('已儲存' + label + '設定');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function patch(next: Partial<Form>) {
    setForm((f) => (f ? ({ ...f, ...next } as Form) : f));
  }
  if (loading && !form) return <LoadingState label={'載入' + label} />;
  if (error && !form && !cards && !loans)
    return (
      <ErrorState message={error} retry={() => setRevision((v) => v + 1)} />
    );
  const currentCurrency =
    items.find((i) => i.id === form?.item_id)?.currency ?? ledger.base_currency;
  return (
    <Stack className="finance-page">
      <Group justify="space-between">
        <Text>
          {label}設定與{isCard ? '最近 12 期帳單' : '攤還試算'}
        </Text>
        <Button
          disabled={
            !eligible.some((i) => isCard || i.currency === ledger.base_currency)
          }
          onClick={() =>
            edit({
              ...(isCard ? cardDefault : loanDefault),
              item_id: eligible.find(
                (i) => isCard || i.currency === ledger.base_currency,
              )!.id,
            } as Form)
          }
        >
          新增{label}設定
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        {isCard
          ? '繳款帳戶須為本位幣或卡片同幣別。外幣卡預估以參考匯率試算，請依實際扣款修改。'
          : '貸款僅支援帳本本位幣；外幣貸款將於後續版本支援。'}
      </Text>
      {!eligible.length && (
        <EmptyState title={'尚無' + label + '科目'}>
          請先在科目樹建立負債科目，勾選「{label}」。
        </EmptyState>
      )}
      {error && !form && (
        <ErrorState message={error} retry={() => setRevision((v) => v + 1)} />
      )}
      {(isCard ? cards?.cards.length === 0 : loans?.loans.length === 0) &&
        eligible.length > 0 && (
          <EmptyState title={'尚無' + label + '設定'}>
            先選擇科目，設定帳單日期或貸款條件。
          </EmptyState>
        )}
      {isCard
        ? cards?.cards.map((c) => (
            <section className="panel finance-card" key={c.item_id}>
              <Group justify="space-between">
                <h3>{c.name}</h3>
                <Group>
                  <Button
                    variant="subtle"
                    onClick={() =>
                      edit(
                        cardSettingsSchema.parse(
                          Object.fromEntries(
                            Object.keys(cardSettingsSchema.shape).map((k) => [
                              k,
                              c[k as keyof typeof c],
                            ]),
                          ),
                        ),
                      )
                    }
                  >
                    編輯{c.name}
                  </Button>
                  <Button variant="subtle" onClick={() => setRemove(c.item_id)}>
                    刪除設定
                  </Button>
                </Group>
              </Group>
              <dl className="finance-stats">
                <div>
                  <dt>本期累計</dt>
                  <dd>{formatMoney(c.current_balance, c.currency)}</dd>
                </div>
                <div>
                  <dt>帳單日期</dt>
                  <dd>{cardNextDates(c)}</dd>
                </div>
                <div>
                  <dt>額度使用率</dt>
                  <dd>{formatPercent(c.utilization)}</dd>
                </div>
                <div>
                  <dt>最近一期未繳</dt>
                  <dd>{formatMoney(c.bills[0]?.unpaid, c.currency)}</dd>
                </div>
              </dl>
              <EdgeScroll axis="x" label={c.name + '帳單'}>
                <table className="finance-table">
                  <thead>
                    <tr>
                      {[
                        '帳單期間',
                        '繳款日',
                        '本期應繳',
                        '已繳',
                        '未繳',
                        '繳款',
                      ].map((x) => (
                        <th key={x}>{x}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {c.bills.map((b) => {
                      const reason = cardPaymentReason(c, b.unpaid);
                      return (
                        <tr key={b.to}>
                          <th>
                            {b.from}～{b.to}
                          </th>
                          <td>{b.due_on}</td>
                          <td>{formatMoney(b.amount_due, c.currency)}</td>
                          <td>{formatMoney(b.paid, c.currency)}</td>
                          <td>
                            {formatMoney(b.unpaid, c.currency)}
                            {units(b.unpaid) <= 0n && <small>已繳清</small>}
                          </td>
                          <td>
                            <Button
                              aria-label={`繳款 ${c.name} ${b.to} 帳單`}
                              disabled={!!reason}
                              onClick={() => {
                                const p = foreignCardPayment(
                                  c,
                                  b.unpaid,
                                  todayTaipei(),
                                );
                                openPaymentEntry(
                                  ledger.id,
                                  p.input,
                                  p.mode,
                                  p.notice,
                                );
                              }}
                            >
                              繳款
                            </Button>
                            {reason && <small>{reason}</small>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </EdgeScroll>
            </section>
          ))
        : loans?.loans.map((l) => (
            <section className="panel finance-card" key={l.item_id}>
              <Group justify="space-between">
                <h3>{l.name}</h3>
                <Group>
                  <Button
                    variant="subtle"
                    onClick={() =>
                      edit(
                        loanSettingsSchema.parse(
                          Object.fromEntries(
                            Object.keys(loanSettingsSchema.shape).map((k) => [
                              k,
                              l[k as keyof typeof l],
                            ]),
                          ),
                        ),
                      )
                    }
                  >
                    編輯{l.name}
                  </Button>
                  <Button variant="subtle" onClick={() => setRemove(l.item_id)}>
                    刪除設定
                  </Button>
                </Group>
              </Group>
              <dl className="finance-stats">
                <div>
                  <dt>實際餘額</dt>
                  <dd>{formatMoney(l.actual_balance, l.currency)}</dd>
                </div>
                <div>
                  <dt>試算餘額</dt>
                  <dd>{formatMoney(l.expected_balance, l.currency)}</dd>
                </div>
                <div>
                  <dt>實際與試算差額</dt>
                  <dd>{formatMoney(l.difference, l.currency)}</dd>
                </div>
              </dl>
              {units(l.difference) !== 0n && (
                <p className="finance-warning" role="status">
                  實際餘額與試算不同，可能有提前還款或利率變動；仍可記帳。
                </p>
              )}
              <Button
                variant="light"
                disabled={units(l.recalculation.principal) <= 0n}
                onClick={() =>
                  edit({
                    ...loanSettingsSchema.parse(
                      Object.fromEntries(
                        Object.keys(loanSettingsSchema.shape).map((k) => [
                          k,
                          l[k as keyof typeof l],
                        ]),
                      ),
                    ),
                    ...l.recalculation,
                  })
                }
              >
                自今日重新試算
              </Button>
              <Text size="sm" c="dimmed">
                重新試算會帶入目前餘額與剩餘期數；確認儲存後取代設定，原有交易不變。
              </Text>
              <h4>本期與下一期</h4>
              <LoanSchedule
                loan={l}
                rows={recentLoanPeriods(l.schedule, loans!.as_of)}
                ledgerId={ledger.id}
                asOf={loans!.as_of}
              />
              <details className="finance-schedule">
                <summary>完整攤還表（{l.schedule.length} 期）</summary>
                <LoanSchedule
                  loan={l}
                  rows={l.schedule}
                  ledgerId={ledger.id}
                  asOf={loans!.as_of}
                  full
                />
              </details>
            </section>
          ))}
      <AdminEditor
        opened={form !== null}
        title={label + '設定'}
        onClose={close}
        busy={busy}
      >
        {form && (
          <Stack>
            <ItemPicker
              items={items}
              label={label + '科目'}
              data={names(eligible)}
              value={form.item_id}
              onChange={(v) => patch({ item_id: v ?? '' })}
              searchable
              required
              disabled={busy}
            />
            <ItemPicker
              items={items}
              label="繳款帳戶"
              data={names(assets, 'payment')}
              value={form.payment_account_id}
              onChange={(v) => patch({ payment_account_id: v })}
              clearable={isCard}
              required={!isCard}
              disabled={busy}
            />
            {'statement_day' in form ? (
              <>
                <TextInput
                  label="結帳日"
                  type="number"
                  min={1}
                  max={31}
                  value={form.statement_day}
                  onChange={(e) =>
                    patch({ statement_day: Number(e.currentTarget.value) })
                  }
                  disabled={busy}
                />
                <TextInput
                  label="繳款日"
                  type="number"
                  min={1}
                  max={31}
                  value={form.due_day}
                  onChange={(e) =>
                    patch({ due_day: Number(e.currentTarget.value) })
                  }
                  disabled={busy}
                />
                <Select
                  label="繳款月份"
                  allowDeselect={false}
                  data={[
                    { value: '0', label: '當月繳款' },
                    { value: '1', label: '次月繳款' },
                  ]}
                  value={String(form.due_month_offset)}
                  onChange={(v) =>
                    patch({ due_month_offset: v === '0' ? 0 : 1 })
                  }
                  disabled={busy}
                />
                {!validCardSchedule(form) && (
                  <p className="finance-warning" role="alert">
                    繳款日須晚於結帳日；結帳日 28 日以後請選「次月繳款」。
                  </p>
                )}
                <TextInput
                  label={'信用額度（' + currentCurrency + '，可留白）'}
                  inputMode="decimal"
                  value={form.credit_limit ?? ''}
                  onChange={(e) =>
                    patch({ credit_limit: e.currentTarget.value || null })
                  }
                  disabled={busy}
                />
              </>
            ) : (
              <>
                <TextInput
                  label={'借款本金（' + currentCurrency + '）'}
                  inputMode="decimal"
                  value={form.principal}
                  onChange={(e) => patch({ principal: e.currentTarget.value })}
                  required
                  disabled={busy}
                />
                <TextInput
                  label="年利率（%）"
                  inputMode="decimal"
                  value={form.annual_rate}
                  onChange={(e) =>
                    patch({ annual_rate: e.currentTarget.value })
                  }
                  required
                  disabled={busy}
                />
                <TextInput
                  label="期數（月）"
                  type="number"
                  min={1}
                  max={600}
                  value={form.term_months}
                  onChange={(e) =>
                    patch({ term_months: Number(e.currentTarget.value) })
                  }
                  disabled={busy}
                />
                <TextInput
                  label="首期繳款日"
                  type="date"
                  value={form.first_payment_on}
                  onChange={(e) =>
                    patch({ first_payment_on: e.currentTarget.value })
                  }
                  disabled={busy}
                />
                <Select
                  label="攤還方法"
                  allowDeselect={false}
                  data={[
                    { value: 'annuity', label: '本息平均攤還' },
                    { value: 'equal_principal', label: '本金平均攤還' },
                  ]}
                  value={form.method}
                  onChange={(v) =>
                    patch({
                      method:
                        v === 'equal_principal' ? 'equal_principal' : 'annuity',
                    })
                  }
                  disabled={busy}
                />
                <ItemPicker
                  items={items}
                  label="利息支出科目"
                  data={names(expenses)}
                  value={form.interest_item_id}
                  onChange={(v) => patch({ interest_item_id: v ?? '' })}
                  required
                  disabled={busy}
                />
              </>
            )}
            {error && <ErrorState message={error} />}
            <Button loading={busy} onClick={() => void save()}>
              儲存設定
            </Button>
          </Stack>
        )}
      </AdminEditor>
      <ConfirmDialog
        opened={!!discard}
        title="未儲存內容"
        confirmLabel="捨棄變更"
        cancelLabel="繼續編輯"
        onCancel={() => setDiscard(null)}
        onConfirm={() => {
          const go = discard;
          setDiscard(null);
          setForm(null);
          go?.();
        }}
      >
        有未儲存的設定，確定要捨棄嗎？
      </ConfirmDialog>
      <ConfirmDialog
        opened={!!remove}
        title={'刪除' + label + '設定'}
        confirmLabel="刪除設定"
        busy={busy}
        onCancel={() => setRemove(null)}
        onConfirm={() => {
          setBusy(true);
          void api(base + '/' + remove, 'DELETE')
            .then(() => {
              setRemove(null);
              setRevision((v) => v + 1);
              notify('已刪除設定');
            })
            .catch((e) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        只刪除設定，已記錄的交易會保留。
      </ConfirmDialog>
    </Stack>
  );
}

function LoanSchedule({
  loan: l,
  rows,
  ledgerId,
  asOf,
  full = false,
}: {
  loan: LoansResult['loans'][number];
  rows: LoansResult['loans'][number]['schedule'];
  ledgerId: string;
  asOf: string;
  full?: boolean;
}) {
  return (
    <EdgeScroll axis="x" label={l.name + (full ? '完整攤還表' : '近期攤還表')}>
      <table className="finance-table">
        <thead>
          <tr>
            {[
              '期別／日期',
              '本金',
              '利息',
              '付款',
              '期末本金',
              '狀態',
              '繳款',
            ].map((x) => (
              <th key={x}>{x}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.period}>
              <th>
                第 {r.period} 期<br />
                {r.due_on}
              </th>
              <td>{formatMoney(r.principal, l.currency)}</td>
              <td>{formatMoney(r.interest, l.currency)}</td>
              <td>{formatMoney(r.payment, l.currency)}</td>
              <td>{formatMoney(r.closing, l.currency)}</td>
              <td>
                {r.due_on > asOf
                  ? '未到期'
                  : units(l.actual_balance) <= units(r.closing)
                    ? '已繳'
                    : '本期'}
              </td>
              <td>
                <Button
                  aria-label={`繳款 ${l.name} 第 ${r.period} 期 ${r.due_on}${full ? '（完整攤還表）' : ''}`}
                  disabled={units(r.payment) === 0n}
                  onClick={() =>
                    openPaymentEntry(ledgerId, loanPayment(l, r, todayTaipei()))
                  }
                >
                  繳款
                </Button>
                {units(r.payment) === 0n && <small>本期無需繳款</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </EdgeScroll>
  );
}
