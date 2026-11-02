// SPDX-License-Identifier: AGPL-3.0-only
import { itemTree } from './design/item-options';
import {
  ManagedTransactionLink,
  managedTarget,
} from './design/managed-transaction';
import { ItemPicker } from './design/item-picker';
import { lazy, Suspense } from 'react';
const StockEntry = lazy(() =>
  import('./stock-entry').then((m) => ({ default: m.StockEntry })),
);
import { ConfirmDialog, LoadingState } from './design/feedback';
import { roundHalfUp } from '@finmichi/core/money';
import {
  AdvancedEntries,
  emptyEntry,
  type DraftEntry,
} from './advanced-entries';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import type { Item, Ledger, NamedRecord } from '@finmichi/core/catalog-schemas';
import type {
  TransactionInput,
  TransactionRecord,
  Preview,
} from '@finmichi/core/transaction-schemas';
import { api, errorMessage } from './api';
import { useMediaQuery } from '@mantine/hooks';
import { EdgeScroll } from './design/edge-scroll';
import { InlineCreate, InlineSelect } from './design/inline-create';
import { formatFullRate, formatMoney, formatRate } from './design/format';
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(
    new Date(),
  );
const kindLabel = {
  income: '收入',
  expense: '支出',
  transfer: '轉帳',
  adjustment: '調整',
};
function StandardTransactions({
  ledger,
  initialEditId,
  onDirtyChange,
  onBusyChange,
  requestDiscard,
  onSaved,
  onClose,
  draft,
}: {
  ledger: Ledger;
  initialEditId?: string | undefined;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  requestDiscard: (action: () => void) => void;
  onSaved: (next: boolean, message: string) => void;
  onClose: () => void;
  draft?: {
    initial?: TransactionInput;
    initialMode?: 'advanced' | 'transfer';
    save: (data: TransactionInput) => Promise<void>;
    confirm?: (data: TransactionInput) => Promise<boolean>;
    label: string;
    occurrence?: boolean;
    successMessage?: string;
  };
}) {
  const base = `/api/ledgers/${ledger.id}`,
    path = base + '/transactions';
  const [items, setItems] = useState<Item[]>([]),
    [payees, setPayees] = useState<NamedRecord[]>([]),
    [projects, setProjects] = useState<NamedRecord[]>([]),
    [memos, setMemos] = useState<NamedRecord[]>([]);
  const [advanced, setAdvanced] = useState(false),
    [advancedEntries, setAdvancedEntries] = useState<DraftEntry[]>([
      emptyEntry(),
      emptyEntry(),
    ]);
  const [editing, setEditing] = useState<TransactionRecord | null>(null),
    [source, setSource] = useState<string | null>(null),
    [destination, setDestination] = useState<string | null>(null),
    [amount, setAmount] = useState(''),
    [destinationAmount, setDestinationAmount] = useState('');
  const [date, setDate] = useState(today),
    [memo, setMemo] = useState(''),
    [payee, setPayee] = useState<string | null>(null),
    [project, setProject] = useState<string | null>(null),
    [invoice, setInvoice] = useState('');
  const [rateOverride, setRateOverride] = useState<Record<
    string,
    string
  > | null>(null);
  const [manualRates, setManualRates] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<Record<string, string>>({}),
    [referenceRates, setReferenceRates] = useState<Record<string, string>>({}),
    [ratesLoading, setRatesLoading] = useState(false),
    [ratesError, setRatesError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null),
    [previewKey, setPreviewKey] = useState(''),
    [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const desktop = useMediaQuery('(min-width: 900px)', false, {
    getInitialValueInEffect: false,
  });
  const [entryType, setEntryType] = useState('expense');
  const [details, setDetails] = useState(false);
  const [creator, setCreator] = useState<
    'source' | 'destination' | 'payees' | 'projects' | number | null
  >(null);
  const [inlineDirty, setInlineDirty] = useState(false);
  const [inlineBusy, setInlineBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const previewRequest = useRef(0);
  const snapshot = JSON.stringify([
    source ||
    destination ||
    amount ||
    advancedEntries.some((e) => e.item_id || e.amount || e.exchange_rate)
      ? advanced
      : null,
    advancedEntries,
    source,
    destination,
    amount,
    destinationAmount,
    date,
    memo,
    payee,
    project,
    invoice,
    manualRates,
  ]);
  const [baseline, setBaseline] = useState(snapshot);
  const [draftReady, setDraftReady] = useState(false);
  useEffect(() => {
    if (!draft || !loaded || draftReady) return;
    const d = draft.initial;
    if (d) {
      if (draft.initialMode === 'transfer' && d.entries.length === 2) {
        setAdvanced(false);
        setEntryType('transfer');
        setSource(d.entries[0]!.item_id);
        setDestination(d.entries[1]!.item_id);
        setAmount(d.entries[0]!.amount.replace(/^-/, ''));
        setDestinationAmount(d.entries[1]!.amount);
      } else {
        setAdvanced(true);
        setAdvancedEntries(
          d.entries.map((e) => ({
            ...e,
            exchange_rate: e.exchange_rate ?? '',
          })),
        );
      }
      setDate(d.occurred_on);
      setMemo(d.memo);
      setPayee(d.payee_id);
      setProject(d.project_id);
      setInvoice(d.invoice_no);
    }
    setDraftReady(true);
  }, [draft, loaded, draftReady]);
  useLayoutEffect(() => {
    onDirtyChange(inlineDirty || snapshot !== baseline);
  }, [snapshot, baseline, inlineDirty, onDirtyChange]);
  useLayoutEffect(() => {
    onBusyChange(busy || inlineBusy);
  }, [busy, inlineBusy, onBusyChange]);
  useEffect(() => {
    if (editing || draft) setBaseline(snapshot);
  }, [editing?.id, draftReady]);
  useEffect(() => {
    let live = true;
    void Promise.all([
      api<Item[]>(base + '/items?include_archived=true'),
      api<NamedRecord[]>(base + '/payees?include_archived=true'),
      api<NamedRecord[]>(base + '/projects?include_archived=true'),
      api<NamedRecord[]>(base + '/memo_templates'),
    ])
      .then(([i, p, j, m]) => {
        if (live) {
          setItems(i.filter((v) => !v.securities));
          setPayees(p);
          setProjects(j);
          setMemos(m);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [base, path]);
  useEffect(() => {
    let live = true;
    setRatesLoading(true);
    setRatesError('');
    setRates({});
    setReferenceRates({});
    void api<{ from_currency: string; rate: string }[]>(
      base + '/exchange-rates?date=' + encodeURIComponent(date),
    )
      .then((values) => {
        if (live) {
          const next = Object.fromEntries(
            values.map((v) => [v.from_currency, v.rate]),
          );
          setRates({ ...next, ...rateOverride });
          setReferenceRates(next);
        }
      })
      .catch((e) => {
        if (live) setRatesError(errorMessage(e));
      })
      .finally(() => {
        if (live) setRatesLoading(false);
      });
    return () => {
      live = false;
    };
  }, [base, date, rateOverride]);
  const sourceItem = items.find((i) => i.id === source),
    destinationItem = items.find((i) => i.id === destination),
    different =
      !!sourceItem &&
      !!destinationItem &&
      sourceItem.currency !== destinationItem.currency;
  const archived =
    !!editing &&
    editing.entries.some(
      (e) => items.find((i) => i.id === e.item_id)?.archived,
    );
  function reset() {
    setEntryType('expense');
    setCreator(null);
    setInlineDirty(false);
    setDetails(false);
    setBaseline(
      JSON.stringify([
        null,
        [emptyEntry(), emptyEntry()],
        null,
        null,
        '',
        '',
        date,
        '',
        null,
        null,
        '',
        {},
      ]),
    );
    setAdvanced(false);
    setAdvancedEntries([emptyEntry(), emptyEntry()]);
    setEditing(null);
    setManualRates({});
    setRateOverride(null);
    setSource(null);
    setDestination(null);
    setAmount('');
    setDestinationAmount('');
    setMemo('');
    setPayee(null);
    setProject(null);
    setInvoice('');
    setPreview(null);
    setPreviewKey('');
    setAccepted(false);
    setConfirmDelete(null);
  }
  function payload(): TransactionInput {
    if (advanced)
      return {
        occurred_on: date,
        memo,
        payee_id: payee,
        project_id: project,
        invoice_no: invoice,
        entries: advancedEntries.map((e) => {
          const rate = e.exchange_rate;
          return {
            item_id: e.item_id,
            amount: e.amount,
            ...(rate ? { exchange_rate: rate } : {}),
          };
        }),
      };
    if (
      !source ||
      !destination ||
      source === destination ||
      !/^([1-9]\d*|0)(\.\d{1,6})?$/.test(amount) ||
      /^0(?:\.0+)?$/.test(amount)
    )
      throw new Error(
        '請選擇不同的來源與目的科目，並輸入大於 0、最多 6 位小數的金額。',
      );
    const target = different ? destinationAmount : amount;
    if (
      !/^([1-9]\d*|0)(\.\d{1,6})?$/.test(target) ||
      /^0(?:\.0+)?$/.test(target)
    )
      throw new Error('請填寫目的科目的實際原幣金額。');
    return {
      occurred_on: date,
      memo,
      payee_id: payee,
      project_id: project,
      invoice_no: invoice,
      entries: [
        {
          item_id: source,
          amount: '-' + amount,
          ...((manualRates[sourceItem!.currency] ??
          rateOverride?.[sourceItem!.currency])
            ? {
                exchange_rate: (manualRates[sourceItem!.currency] ??
                  rateOverride?.[sourceItem!.currency])!,
              }
            : {}),
        },
        {
          item_id: destination,
          amount: target,
          ...((manualRates[destinationItem!.currency] ??
          rateOverride?.[destinationItem!.currency])
            ? {
                exchange_rate: (manualRates[destinationItem!.currency] ??
                  rateOverride?.[destinationItem!.currency])!,
              }
            : {}),
        },
      ],
    };
  }
  async function calculate() {
    const ticket = ++previewRequest.current;
    setPreviewError('');
    setBusy(true);
    setError('');

    try {
      const data = payload(),
        value = await api<Preview>(
          path + (editing ? '/' + editing.id : '') + '/preview',
          'POST',
          data,
        );
      if (ticket !== previewRequest.current) return;
      setPreview(value);
      setPreviewKey(JSON.stringify(data));
      setAccepted(false);
    } catch (e) {
      setPreview(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  let payloadKey = '';
  try {
    const data = payload();
    if (
      data.entries.length >= 2 &&
      data.entries.every(
        (e) => e.item_id && /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(e.amount),
      )
    )
      payloadKey = JSON.stringify(data);
  } catch {
    /* Incomplete input is not sent. */
  }
  const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    const ticket = ++previewRequest.current;
    setAccepted(false);
    setPreviewError('');
    if (!payloadKey || ratesLoading || !loaded || (initialEditId && !editing))
      return;
    let live = true;
    const timer = setTimeout(() => {
      if (ticket !== previewRequest.current) return;
      void api<Preview>(
        path + (editing ? '/' + editing.id : '') + '/preview',
        'POST',
        JSON.parse(payloadKey),
      )
        .then((value) => {
          if (live && ticket === previewRequest.current) {
            setPreview(value);
            setPreviewKey(payloadKey);
            setError('');
          }
        })
        .catch((e) => {
          if (live && ticket === previewRequest.current) {
            setPreview(null);
            setPreviewError(errorMessage(e));
          }
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [payloadKey, path, editing?.id, initialEditId, ratesLoading, loaded]);
  let fresh = false;
  try {
    fresh = !!preview && previewKey === JSON.stringify(payload());
  } catch {
    /* Incomplete form cannot be saved. */
  }
  async function save(next = false) {
    setBusy(true);
    setError('');

    try {
      if (
        (initialEditId && !editing) ||
        !fresh ||
        (preview!.warnings.length > 0 && !accepted)
      )
        throw new Error('請先試算目前欄位，並確認匯率警告。');
      if (draft) {
        const data = payload();
        // A scheduled template must not pin today's suggested rate unless the user entered it.
        data.entries = data.entries.map((e, i) => {
          const currency = items.find((v) => v.id === e.item_id)?.currency;
          const explicit = advanced
            ? advancedEntries[i]?.exchange_rate
            : currency && (manualRates[currency] || rateOverride?.[currency]);
          if (explicit) return e;
          const { exchange_rate: _, ...entry } = e;
          void _;
          return entry;
        });
        if (draft.confirm && !(await draft.confirm(data))) return;
        await draft.save(data);
      } else
        await api(
          path + (editing ? '/' + editing.id : ''),
          editing ? 'PATCH' : 'POST',
          payload(),
        );
      reset();

      onSaved(
        next,
        draft ? (draft.successMessage ?? '已儲存週期樣板') : '交易已儲存。',
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function edit(id: string) {
    setBusy(true);
    setError('');

    try {
      const tx = await api<TransactionRecord>(path + '/' + id);
      const useAdvanced =
        tx.entries.length !== 2 ||
        !tx.entries[0]!.amount.startsWith('-') ||
        tx.entries[1]!.amount.startsWith('-') ||
        tx.entries[0]!.item_id === tx.entries[1]!.item_id ||
        (tx.entries[0]!.currency === tx.entries[1]!.currency &&
          (tx.entries[0]!.amount.slice(1) !== tx.entries[1]!.amount ||
            tx.entries[0]!.exchange_rate !== tx.entries[1]!.exchange_rate));
      reset();
      setEditing(tx);
      setAdvanced(useAdvanced);
      setEntryType(tx.kind === 'adjustment' ? 'transfer' : tx.kind);
      setDetails(!!tx.invoice_no);
      setAdvancedEntries(
        tx.entries.map((e) => ({
          item_id: e.item_id,
          amount: e.amount,
          exchange_rate: e.exchange_rate,
        })),
      );
      setDate(tx.occurred_on);
      setRateOverride(
        Object.fromEntries(
          tx.entries
            .filter((e) => e.currency !== ledger.base_currency)
            .map((e) => [e.currency, e.exchange_rate]),
        ),
      );
      setMemo(tx.memo);
      setPayee(tx.payee_id);
      setProject(tx.project_id);
      setInvoice(tx.invoice_no);
      setSource(tx.entries[0]!.item_id);
      setDestination(tx.entries[1]!.item_id);
      setAmount(tx.entries[0]!.amount.slice(1));
      setDestinationAmount(tx.entries[1]!.amount);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (initialEditId) void edit(initialEditId);
  }, [initialEditId, path]);
  async function remove(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(path + '/' + id, 'DELETE');
      if (editing?.id === id) reset();
      setConfirmDelete(null);

      onSaved(false, '交易與所有分錄已刪除。');
    } catch (e) {
      setConfirmDelete(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const options = (values: NamedRecord[], selected: string | null) =>
    values
      .filter((v) => !v.archived || v.id === selected)
      .map((v) => ({
        value: v.id,
        label: v.name + (v.archived ? '（已封存）' : ''),
      }));
  const itemOptions = (
    selected: string | null,
    role: 'source' | 'destination',
  ) =>
    items
      .filter((i) => !i.archived || i.id === selected)
      .filter(
        (i) =>
          i.id === selected ||
          (role === 'source' && entryType === 'income'
            ? i.kind === 'income'
            : role === 'destination' && entryType === 'expense'
              ? i.kind === 'expense'
              : i.kind === 'asset' || i.kind === 'liability'),
      )
      .map((i) => ({
        value: i.id,
        label: `${i.name} (${i.currency})${i.archived ? '（已封存）' : ''}`,
      }));
  const currencies = [
    ...new Set(
      [sourceItem?.currency, destinationItem?.currency].filter(
        (c): c is string => !!c && c !== ledger.base_currency,
      ),
    ),
  ];
  // Catalog loading and draft hydration must finish before a user can edit.
  // Otherwise the late initial payload can overwrite already typed fields.
  const preparing = !!(draft && (!loaded || !draftReady));
  const blocked =
    busy || inlineBusy || preparing || !!(initialEditId && !editing);
  function createFor(target: typeof creator) {
    if (creator !== null && inlineDirty)
      requestDiscard(() => {
        setCreator(target);
        setInlineDirty(false);
      });
    else {
      setCreator(target);
      setInlineDirty(false);
    }
  }
  function switchMode(value: string) {
    if (value === 'advanced') {
      let entries: DraftEntry[];
      try {
        entries = payload().entries.map((e) => ({
          ...e,
          exchange_rate: e.exchange_rate ?? '',
        }));
      } catch {
        entries = [
          {
            ...emptyEntry(),
            item_id: source ?? '',
            amount: amount ? '-' + amount : '',
          },
          {
            ...emptyEntry(),
            item_id: destination ?? '',
            amount: destinationAmount || amount,
          },
        ];
      }
      setAdvancedEntries(entries);
      setAdvanced(true);
      setPreview(null);
    } else {
      const change = () => {
        if (advanced) {
          setSource(advancedEntries[0]?.item_id ?? null);
          setDestination(advancedEntries[1]?.item_id ?? null);
          setAmount(advancedEntries[0]?.amount.replace(/^-/, '') ?? '');
          setDestinationAmount(advancedEntries[1]?.amount ?? '');
        } else if (value !== entryType) {
          setSource(null);
          setDestination(null);
        }
        setAdvanced(false);
        setEntryType(value);
        setPreview(null);
      };
      if (advanced && advancedEntries.length > 2) requestDiscard(change);
      else change();
    }
  }
  return (
    <div className="entry-editor" aria-busy={busy || inlineBusy || preparing}>
      <EdgeScroll label="記帳內容" className="entry-fields">
        <Stack gap="sm">
          <Title order={3}>{editing ? '交易內容' : '快速記帳'}</Title>
          <SegmentedControl
            aria-label="記帳類型"
            value={advanced ? 'advanced' : entryType}
            onChange={switchMode}
            disabled={blocked || archived || !!draft?.occurrence}
            data={[
              { value: 'expense', label: '支出' },
              { value: 'income', label: '收入' },
              { value: 'transfer', label: '轉帳' },
              { value: 'advanced', label: '進階' },
            ]}
          />
          <Text size="xs" c="dimmed">
            選擇來源與目的，填入實際金額。
          </Text>
          {preparing && !error && <LoadingState label="載入草稿" />}
          {initialEditId && !editing && busy && (
            <LoadingState label="載入交易" />
          )}
          {error && (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          {ledger.locked_until && (
            <Text>已關帳至 {ledger.locked_until}（含當日）</Text>
          )}
          <Paper className="entry-paper">
            <Stack>
              {archived && (
                <Alert>
                  這筆交易含封存科目，可修改日期、摘要等欄位；原分錄保留。
                </Alert>
              )}
              {advanced ? (
                <AdvancedEntries
                  lockedItems={draft?.occurrence ?? false}
                  entries={advancedEntries}
                  onChange={setAdvancedEntries}
                  items={items}
                  baseCurrency={ledger.base_currency}
                  rates={referenceRates}
                  disabled={blocked || archived}
                  onCreateItem={(index) => createFor(index)}
                />
              ) : (
                <>
                  {' '}
                  <TextInput
                    label={`來源金額 (${sourceItem?.currency ?? ledger.base_currency})`}
                    className="entry-amount"
                    data-autofocus
                    error={
                      amount && !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount)
                        ? '請輸入最多6位小數的正數金額。'
                        : undefined
                    }
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.currentTarget.value)}
                    disabled={blocked || archived}
                    required
                  />
                  <ItemPicker
                    items={items}
                    recentKey={entryType + ':source'}
                    label="來源科目"
                    searchable
                    data={itemOptions(source, 'source')}
                    value={source}
                    onChange={setSource}
                    onCreate={() => createFor('source')}
                    disabled={blocked || archived}
                    required
                  />
                  <Text ta="center">↓ 來源 → 目的</Text>
                  <ItemPicker
                    items={items}
                    recentKey={entryType + ':destination'}
                    label="目的科目"
                    searchable
                    data={itemOptions(destination, 'destination')}
                    value={destination}
                    onChange={setDestination}
                    onCreate={() => createFor('destination')}
                    disabled={blocked || archived}
                    required
                  />
                  {different && (
                    <TextInput
                      label={`目的金額 (${destinationItem!.currency})`}
                      description="填寫目的科目實際收到或記錄的原幣金額，不自動換算。"
                      className="entry-amount"
                      inputMode="decimal"
                      value={destinationAmount}
                      onChange={(e) =>
                        setDestinationAmount(e.currentTarget.value)
                      }
                      disabled={blocked || archived}
                      required
                    />
                  )}
                </>
              )}
              {creator !== null && (
                <InlineCreate
                  key={String(creator)}
                  base={base}
                  resource={
                    creator === 'payees' || creator === 'projects'
                      ? creator
                      : 'items'
                  }
                  currency={ledger.base_currency}
                  items={items}
                  onDirty={setInlineDirty}
                  onBusy={setInlineBusy}
                  onCancel={() => {
                    const close = () => {
                      setCreator(null);
                      setInlineDirty(false);
                    };
                    if (inlineDirty) requestDiscard(close);
                    else close();
                  }}
                  onCreated={(row) => {
                    if (creator === 'payees') {
                      setPayees((old) => [...old, row as NamedRecord]);
                      setPayee(row.id);
                    } else if (creator === 'projects') {
                      setProjects((old) => [...old, row as NamedRecord]);
                      setProject(row.id);
                    } else {
                      setItems((old) => [...old, row as Item]);
                      if (creator === 'source') setSource(row.id);
                      else if (creator === 'destination')
                        setDestination(row.id);
                      else
                        setAdvancedEntries((old) =>
                          old.map((e, i) =>
                            i === creator ? { ...e, item_id: row.id } : e,
                          ),
                        );
                    }
                    setCreator(null);
                    setInlineDirty(false);
                  }}
                />
              )}
              <TextInput
                label="交易日期"
                aria-label="交易日期"
                type="date"
                value={date}
                onChange={(e) => {
                  if (!archived) {
                    setRateOverride(null);
                    setManualRates({});
                    setAdvancedEntries((old) =>
                      old.map((e) => ({ ...e, exchange_rate: '' })),
                    );
                  }
                  setDate(e.currentTarget.value);
                }}
                disabled={blocked}
                required
              />
              {ratesError && (
                <Alert color="red">匯率讀取失敗：{ratesError}</Alert>
              )}
              {!advanced &&
                currencies.map((c) => (
                  <TextInput
                    key={c}
                    label={`${c} → ${ledger.base_currency} 匯率`}
                    description={
                      referenceRates[c]
                        ? `當日參考：${referenceRates[c]}；情境 C 優先以輸入值比較偏差；儲存的是有效匯率。`
                        : '無當日參考；可輸入比較匯率。C 以兩側實際金額決定有效匯率。'
                    }
                    value={rates[c] ?? ''}
                    onChange={(e) => {
                      setRates({ ...rates, [c]: e.currentTarget.value });
                      setManualRates({
                        ...manualRates,
                        [c]: e.currentTarget.value,
                      });
                    }}
                    inputMode="decimal"
                    disabled={blocked || ratesLoading || archived}
                  />
                ))}
              {editing &&
                editing.entries.some((e) => {
                  const item = items.find((i) => i.id === e.item_id);
                  return (
                    item &&
                    (item.archived || itemTree(items).parents.has(item.id))
                  );
                }) && (
                  <Text c="var(--warn)">
                    這筆交易包含歷史科目，保留原科目可儲存；更換時請選未封存的末端科目。
                  </Text>
                )}
              <InlineSelect
                label="收付人"
                clearable
                searchable
                data={options(payees, payee)}
                value={payee}
                onChange={setPayee}
                onCreate={() => createFor('payees')}
                disabled={blocked || !!draft?.occurrence}
              />
              <InlineSelect
                label="專案"
                clearable
                searchable
                data={options(projects, project)}
                value={project}
                onChange={setProject}
                onCreate={() => createFor('projects')}
                disabled={blocked || !!draft?.occurrence}
              />
              <Textarea
                label="摘要"
                autosize
                minRows={2}
                value={memo}
                onChange={(e) => setMemo(e.currentTarget.value)}
                maxLength={2000}
                disabled={blocked}
              />
              {memos.length > 0 && (
                <div>
                  <Text size="sm" fw={500}>
                    常用摘要
                  </Text>
                  <EdgeScroll axis="x" label="常用摘要">
                    <div className="entry-memo-chips">
                      {memos
                        .filter((m) => !m.archived)
                        .map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            className="filter-chip"
                            disabled={blocked}
                            onClick={() => setMemo(m.memo ?? '')}
                          >
                            {m.name}
                          </button>
                        ))}
                    </div>
                  </EdgeScroll>
                </div>
              )}
              <Button
                variant="subtle"
                aria-expanded={details}
                onClick={() => setDetails((v) => !v)}
              >
                發票與進階欄位
              </Button>
              {details && (
                <TextInput
                  label="發票號碼"
                  value={invoice}
                  onChange={(e) => setInvoice(e.currentTarget.value)}
                  maxLength={100}
                  disabled={blocked || !!draft?.occurrence}
                />
              )}
              {previewError && (
                <Alert color="red" role="alert">
                  {previewError}
                </Alert>
              )}
              <Title order={4}>分錄預覽</Title>
              {!fresh && !previewError && (
                <Text size="sm" c="dimmed">
                  填妥科目與金額後，自動顯示分錄與本位幣金額。
                </Text>
              )}
              {
                <Button
                  variant="subtle"
                  onClick={() => void calculate()}
                  disabled={blocked || ratesLoading}
                >
                  {previewError ? '重試' : '試算交易'}
                </Button>
              }
              {fresh && preview && (
                <Stack gap="xs">
                  <Text>交易類別：{kindLabel[preview.kind]}</Text>
                  <div className="entry-preview" role="status">
                    {preview.entries.map((e, i) => (
                      <span key={i}>
                        {i > 0 ? ' → ' : ''}
                        {items.find((item) => item.id === e.item_id)?.name ??
                          '科目'}{' '}
                        <span className="num">
                          {formatMoney(e.amount, e.currency, {
                            compact: true,
                            sign: 'always',
                          })}
                        </span>
                      </span>
                    ))}
                  </div>
                  {preview.entries.map((e, i) => (
                    <Text key={i} style={{ overflowWrap: 'anywhere' }}>
                      分錄 {i + 1}：{formatMoney(e.amount, e.currency)}；本位幣{' '}
                      {formatMoney(e.base_amount, ledger.base_currency)}；
                      {preview.scenario === 'C' ? '有效匯率' : '匯率'}{' '}
                      <span
                        title={`完整匯率：${formatFullRate(e.exchange_rate)}`}
                      >
                        {formatRate(e.exchange_rate)}
                      </span>
                    </Text>
                  ))}
                  {preview.fx_comparisons.map((c) => (
                    <Text
                      key={c.entry_index}
                      style={{ overflowWrap: 'anywhere' }}
                    >
                      外幣分錄 {c.entry_index + 1}：有效匯率{' '}
                      <span
                        title={`完整匯率：${formatFullRate(c.effective_rate)}`}
                      >
                        {formatRate(c.effective_rate)}
                      </span>
                      ；參考來源：
                      {c.reference_source === 'user_input'
                        ? '使用者輸入'
                        : c.reference_source === 'exchange_rates'
                          ? '當日匯率'
                          : c.reference_source === 'bot-cross'
                            ? `交叉匯率（臺銀，日期 ${c.reference_date}）`
                            : c.reference_source === 'bot'
                              ? `臺銀中價（日期 ${c.reference_date}）`
                              : '無參考匯率（不比較）'}
                      {c.reference_rate !== null && (
                        <>
                          {' '}
                          <span
                            title={`完整匯率：${formatFullRate(c.reference_rate)}`}
                          >
                            {formatRate(c.reference_rate)}
                          </span>
                          ；偏差 {roundHalfUp(c.deviation_percent!, 2)}%
                        </>
                      )}
                    </Text>
                  ))}
                  {preview.warnings.length > 0 && (
                    <>
                      <Alert className="entry-fx-warning" role="alert">
                        有效匯率偏離參考匯率超過 5%，請核對兩側實際金額。
                      </Alert>
                      <Checkbox
                        label="已確認匯率差異，仍要儲存"
                        checked={accepted}
                        onChange={(e) => setAccepted(e.currentTarget.checked)}
                      />
                    </>
                  )}
                </Stack>
              )}
              {editing && (
                <>
                  <Button
                    color="red"
                    variant="subtle"
                    disabled={blocked}
                    onClick={() => setConfirmDelete(editing.id)}
                  >
                    刪除交易
                  </Button>
                  <ConfirmDialog
                    opened={confirmDelete !== null}
                    title="刪除交易"
                    confirmLabel="確認刪除交易"
                    cancelLabel="保留交易"
                    onCancel={() => setConfirmDelete(null)}
                    onConfirm={() => void remove(editing.id)}
                    busy={blocked}
                  >
                    確定刪除交易與所有分錄？
                  </ConfirmDialog>
                </>
              )}
            </Stack>
          </Paper>
        </Stack>
      </EdgeScroll>
      <div className="entry-footer">
        <Button
          onClick={() => void save()}
          disabled={
            blocked ||
            creator !== null ||
            ratesLoading ||
            !fresh ||
            (!!preview?.warnings.length && !accepted)
          }
        >
          {draft?.label ?? '儲存交易'}
        </Button>
        {desktop && !draft && (
          <Button
            variant="light"
            onClick={() => void save(true)}
            disabled={
              blocked ||
              creator !== null ||
              ratesLoading ||
              !fresh ||
              (!!preview?.warnings.length && !accepted)
            }
          >
            儲存並新增下一筆
          </Button>
        )}
        <Button
          variant="default"
          onClick={onClose}
          disabled={busy || inlineBusy}
        >
          取消
        </Button>
      </div>
    </div>
  );
}

type EntryProps = Parameters<typeof StandardTransactions>[0];
export function Transactions(props: EntryProps) {
  const [mode, setMode] = useState<'standard' | 'stock'>('standard'),
    [metadata, setMetadata] = useState<{
      security_id?: string;
      security_trade_id?: string;
      dividend_id?: string;
      deposit_id?: string;
    } | null>(null),
    [loading, setLoading] = useState(!!props.initialEditId);
  useEffect(() => {
    if (!props.initialEditId) return;
    let live = true;
    void api<TransactionRecord>(
      `/api/ledgers/${props.ledger.id}/transactions/${props.initialEditId}`,
    )
      .then((r) => {
        if (live) {
          setMetadata(r);
          if (r.security_trade_id) setMode('stock');
        }
      })
      // The original editor owns failed-load feedback and disabled fields.
      // A metadata lookup failure must not replace its error state.
      .catch(() => {})
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [props.initialEditId, props.ledger.id]);
  if (loading) return <LoadingState label="載入交易類型" />;
  if (metadata && managedTarget(metadata))
    return (
      <Stack>
        <Alert>
          {managedTarget(metadata)!.label}
          ，請前往對應管理畫面修改；一般交易編輯不會改動這筆資料。
        </Alert>
        <ManagedTransactionLink row={metadata} />
        <Button variant="default" onClick={props.onClose}>
          關閉
        </Button>
      </Stack>
    );
  return (
    <div className="entry-mode-container">
      <div className="stock-mode-picker">
        {!props.initialEditId && !props.draft && (
          <>
            <Button
              variant={mode === 'standard' ? 'filled' : 'light'}
              aria-pressed={mode === 'standard'}
              onClick={() => props.requestDiscard(() => setMode('standard'))}
            >
              一般記帳
            </Button>
            <Button
              variant={mode === 'stock' ? 'filled' : 'light'}
              aria-pressed={mode === 'stock'}
              disabled={props.ledger.base_currency !== 'TWD'}
              onClick={() => props.requestDiscard(() => setMode('stock'))}
            >
              股票
            </Button>
            {props.ledger.base_currency !== 'TWD' && (
              <Text size="sm">股票功能目前僅支援本位幣為新臺幣的帳本</Text>
            )}
          </>
        )}
      </div>
      {mode === 'stock' ? (
        <Suspense fallback={<LoadingState label="載入股票模式" />}>
          <StockEntry
            ledger={props.ledger}
            initialSecurity={metadata?.security_id}
            initialTrade={metadata?.security_trade_id}
            onDirtyChange={props.onDirtyChange}
            onBusyChange={props.onBusyChange}
            onClose={props.onClose}
            onSaved={() => props.onSaved(false, '股票紀錄已儲存')}
          />
        </Suspense>
      ) : (
        <StandardTransactions {...props} />
      )}
    </div>
  );
}
