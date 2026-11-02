// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import type { Item, Ledger } from '@finmichi/core/catalog-schemas';
import type { TransactionInput } from '@finmichi/core/transaction-schemas';
import type {
  RecurringInput,
  RecurringRule,
  RecurringOccurrence,
  RecurringState,
} from '@finmichi/core/recurring-schemas';
import {
  frequencyPreview,
  nextOccurrence,
} from '@finmichi/core/recurring-calendar';
import { api, errorMessage, apiErrorMessage } from './api';
import { Transactions } from './transactions';
import { AdminEditor } from './design/admin-editor';
import {
  ConfirmDialog,
  EmptyState,
  LoadingState,
  ErrorState,
  notify,
} from './design/feedback';
import { todayTaipei } from './design/display-math';
import { guardNavigation, navigate, useLocation } from './design/location';
import { formatMoney } from './design/format';
import { generatedAt } from './report-common';
const blank = (): Omit<RecurringInput, 'template'> => ({
  name: '',
  frequency: 'monthly',
  interval: 1,
  day_of_month: 31,
  weekday: null,
  month: null,
  day: null,
  start_on: todayTaipei(),
  end_on: null,
  active: true,
  auto_post: false,
});
export function Recurring({ ledger }: { ledger: Ledger }) {
  const base = `/api/ledgers/${ledger.id}/recurring`,
    location = useLocation();
  const tab =
    new URLSearchParams(location.split('?')[1]).get('view') === 'pending'
      ? 'pending'
      : 'rules';
  const [state, setState] = useState<RecurringState | null>(null),
    [rows, setRows] = useState<RecurringOccurrence[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<{
      rule?: RecurringRule;
      occurrence?: RecurringOccurrence;
    } | null>(null),
    [schedule, setSchedule] = useState(blank),
    [deleting, setDeleting] = useState<string | null>(null),
    [discard, setDiscard] = useState<(() => void) | null>(null);
  const templateDirty = useRef(false);
  const [items, setItems] = useState<Item[]>([]);
  const dirty = useRef(false),
    working = useRef(false);
  useEffect(
    () =>
      guardNavigation((proceed) => {
        if (!editor) {
          proceed();
          return;
        }
        if (working.current) return;
        if (dirty.current || templateDirty.current) setDiscard(() => proceed);
        else proceed();
      }),
    [editor],
  );
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    void Promise.all([
      api<RecurringState>(base),
      api<RecurringOccurrence[]>(base + '/occurrences'),
      api<Item[]>(`/api/ledgers/${ledger.id}/items?include_archived=true`),
    ])
      .then(([s, r, i]) => {
        if (live) {
          setState(s);
          setItems(i);
          setRows(r);
          setSelected([]);
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [base, revision]);
  function refreshed() {
    setRevision((v) => v + 1);
    window.dispatchEvent(new Event('ledger:catalogs-changed'));
    window.dispatchEvent(new Event('ledger:transactions-changed'));
  }
  async function act(operation: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    try {
      await operation();
      notify(message);
      refreshed();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function close() {
    if (working.current) return;
    if (dirty.current || templateDirty.current)
      setDiscard(() => () => setEditor(null));
    else setEditor(null);
  }
  function open(rule?: RecurringRule, occurrence?: RecurringOccurrence) {
    dirty.current = false;
    templateDirty.current = false;
    working.current = false;
    setSchedule(
      rule
        ? (({ template: _, id: __, ledger_id: ___, next_on: ____, ...s }) => {
            void _;
            void __;
            void ___;
            void ____;
            return s;
          })(rule)
        : blank(),
    );
    setEditor({
      ...(rule ? { rule } : {}),
      ...(occurrence ? { occurrence } : {}),
    });
  }
  async function saveDraft(data: TransactionInput) {
    if (editor?.occurrence) {
      await api(base + '/occurrences/' + editor.occurrence.id, 'PATCH', {
        occurred_on: data.occurred_on,
        memo: data.memo,
        entries: data.entries,
      });
    } else {
      const { occurred_on: _, ...template } = data;
      void _;
      await api(
        base + (editor?.rule ? '/' + editor.rule.id : ''),
        editor?.rule ? 'PUT' : 'POST',
        { ...schedule, template },
      );
    }
  }
  const initial = editor?.occurrence
    ? {
        ...editor.occurrence.template,
        occurred_on: editor.occurrence.occurred_on,
      }
    : editor?.rule
      ? {
          ...editor.rule.template,
          occurred_on: editor.rule.next_on ?? todayTaipei(),
        }
      : undefined;
  const worker = state?.worker;
  return (
    <Stack>
      <div className="panel-heading">
        <h2>週期交易</h2>
        <Button onClick={() => open()}>新增規則</Button>
      </div>
      <Text size="sm">
        每日 06:00（臺北）產生；入帳前可確認或修改當期金額、日期與摘要。
      </Text>
      <Text size="sm">
        worker：
        {worker
          ? `${worker.last_finished_at || worker.last_started_at ? generatedAt((worker.last_finished_at ?? worker.last_started_at)!) : '尚未執行'} · ${worker.status === 'success' ? '成功' : worker.status === 'running' ? '執行中' : '執行失敗，稍後重試'}${worker.next_retry_at ? '；下次重試 ' + generatedAt(worker.next_retry_at) : ''}`
          : '尚未執行'}
      </Text>
      <Group>
        <Button
          variant="default"
          disabled={busy}
          onClick={() =>
            void act(() => api(base + '/generate', 'POST'), '已產生到今天')
          }
        >
          產生到今天
        </Button>
      </Group>
      <nav aria-label="週期交易檢視" className="report-nav">
        <a
          href="/admin/recurring"
          aria-current={tab === 'rules' ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate('/admin/recurring');
          }}
        >
          規則清單
        </a>
        <a
          href="/admin/recurring?view=pending"
          aria-current={tab === 'pending' ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate('/admin/recurring?view=pending');
          }}
        >
          待確認（{state?.pending_count ?? 0}）
        </a>
      </nav>
      {busy && <LoadingState label="載入週期交易" hasData={!!state} />}
      {error && <ErrorState message={error} retry={() => refreshed()} />}
      {tab === 'rules' && state && (
        <>
          {!state.rules.length && (
            <EmptyState title="尚無週期規則">
              新增規則，重複的記帳會先放進待確認清單。
            </EmptyState>
          )}
          <div className="admin-records">
            {state.rules.map((r) => (
              <section className="panel admin-record" key={r.id}>
                <h3>{r.name}</h3>
                {r.template.entries.map((entry, index) => {
                  const item = items.find((i) => i.id === entry.item_id);
                  return (
                    <Text key={index} className="num">
                      {item?.name ?? '已移除科目'}：
                      {formatMoney(
                        entry.amount,
                        item?.currency ?? ledger.base_currency,
                      )}
                    </Text>
                  );
                })}
                <Text>{frequencyPreview(r, r.next_on)}</Text>
                <Text>
                  {r.active ? '啟用' : '停用'} ·{' '}
                  {r.auto_post ? '自動入帳' : '手動確認'}
                  {r.end_on ? ' · 結束 ' + r.end_on : ''}
                </Text>
                <Group>
                  <Button
                    aria-label={'編輯 ' + r.name}
                    variant="light"
                    onClick={() => open(r)}
                  >
                    編輯
                  </Button>
                  <Button
                    variant="subtle"
                    aria-label={(r.active ? '停用 ' : '啟用 ') + r.name}
                    onClick={() =>
                      void act(
                        () =>
                          api(base + '/' + r.id, 'PUT', {
                            ...(({
                              id: _,
                              ledger_id: __,
                              next_on: ___,
                              ...v
                            }) => {
                              void _;
                              void __;
                              void ___;
                              return v;
                            })(r),
                            active: !r.active,
                          }),
                        r.active ? '已停用規則' : '已啟用規則',
                      )
                    }
                  >
                    {r.active ? '停用' : '啟用'}
                  </Button>
                  <Button
                    color="red"
                    variant="subtle"
                    aria-label={'刪除 ' + r.name}
                    onClick={() => setDeleting(r.id)}
                  >
                    刪除
                  </Button>
                </Group>
              </section>
            ))}
          </div>
        </>
      )}
      {tab === 'pending' && state && (
        <>
          {!rows.length ? (
            <EmptyState title="沒有待確認的週期交易">
              可按「產生到今天」，或等待每日排程。
            </EmptyState>
          ) : (
            <>
              <Group>
                <Checkbox
                  label="全選待確認"
                  checked={selected.length === rows.length}
                  onChange={(e) =>
                    setSelected(
                      e.currentTarget.checked ? rows.map((r) => r.id) : [],
                    )
                  }
                />
                <Button
                  disabled={busy || !selected.length}
                  onClick={() =>
                    void act(
                      () =>
                        (async () => {
                          const result: RecurringOccurrence[] = [];
                          for (let i = 0; i < selected.length; i += 100)
                            result.push(
                              ...(await api<RecurringOccurrence[]>(
                                base + '/post',
                                'POST',
                                { ids: selected.slice(i, i + 100) },
                              )),
                            );
                          if (result.some((r) => r.status === 'failed'))
                            notify('部分入帳失敗，請查看中文原因後重試');
                        })(),
                      '已完成所選入帳，請查看各筆結果',
                    )
                  }
                >
                  確認所選入帳
                </Button>
              </Group>
              {Array.from(new Set(rows.map((r) => r.occurred_on))).map(
                (day) => (
                  <section key={day}>
                    <h3>{day}</h3>
                    <div className="admin-records">
                      {rows
                        .filter((r) => r.occurred_on === day)
                        .map((o) => (
                          <section key={o.id} className="panel admin-record">
                            <Checkbox
                              label={'選取 ' + o.rule_name + ' ' + o.occurs_on}
                              checked={selected.includes(o.id)}
                              onChange={(e) => {
                                const checked = e.currentTarget.checked;
                                setSelected((v) =>
                                  checked
                                    ? [...v, o.id]
                                    : v.filter((id) => id !== o.id),
                                );
                              }}
                            />
                            <h4>{o.rule_name}</h4>
                            <Text>
                              原期日：{o.occurs_on} ·{' '}
                              {o.template.memo || '無摘要'}
                            </Text>
                            {o.template.entries.map((e, i) => (
                              <Text key={i} className="num">
                                分錄 {i + 1}：
                                {formatMoney(
                                  e.amount,
                                  items.find((i) => i.id === e.item_id)
                                    ?.currency ?? ledger.base_currency,
                                )}
                              </Text>
                            ))}
                            {o.status === 'failed' && (
                              <div className="recurring-warning" role="status">
                                入帳失敗：
                                {apiErrorMessage(o.error_code ?? undefined)}
                              </div>
                            )}
                            <Group>
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    () =>
                                      api(
                                        base + '/occurrences/' + o.id + '/post',
                                        'POST',
                                      ),
                                    '已處理入帳，請查看結果',
                                  )
                                }
                              >
                                入帳 {o.rule_name}
                              </Button>
                              <Button
                                variant="light"
                                onClick={() => open(undefined, o)}
                              >
                                修改當期 {o.rule_name}
                              </Button>
                              <Button
                                variant="subtle"
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    () =>
                                      api(
                                        base + '/occurrences/' + o.id + '/skip',
                                        'POST',
                                      ),
                                    '已略過當期',
                                  )
                                }
                              >
                                略過 {o.rule_name}
                              </Button>
                            </Group>
                          </section>
                        ))}
                    </div>
                  </section>
                ),
              )}
            </>
          )}
        </>
      )}
      <AdminEditor
        opened={editor !== null}
        title={
          editor?.occurrence
            ? '修改當期'
            : editor?.rule
              ? '編輯週期規則'
              : '新增週期規則'
        }
        onClose={close}
        busy={false}
      >
        {editor && (
          <>
            {!editor.occurrence && (
              <Stack gap="sm">
                <TextInput
                  label="規則名稱"
                  required
                  maxLength={200}
                  value={schedule.name}
                  onChange={(e) => {
                    const targetValue = e.currentTarget.value;
                    dirty.current = true;
                    setSchedule((s) => ({ ...s, name: targetValue }));
                  }}
                />
                <Select
                  label="頻率"
                  value={schedule.frequency}
                  data={[
                    { value: 'monthly', label: '每月' },
                    { value: 'weekly', label: '每週' },
                    { value: 'yearly', label: '每年' },
                  ]}
                  onChange={(v) => {
                    dirty.current = true;
                    setSchedule((s) => ({
                      ...s,
                      frequency: v as RecurringInput['frequency'],
                      day_of_month: v === 'monthly' ? 31 : null,
                      weekday: v === 'weekly' ? 0 : null,
                      month: v === 'yearly' ? 2 : null,
                      day: v === 'yearly' ? 29 : null,
                    }));
                  }}
                />
                <NumberInput
                  label="每 N 期"
                  min={1}
                  max={12}
                  allowDecimal={false}
                  value={schedule.interval}
                  onChange={(v) => {
                    dirty.current = true;
                    setSchedule((s) => ({ ...s, interval: Number(v) }));
                  }}
                />
                {schedule.frequency === 'monthly' && (
                  <NumberInput
                    label="每月日期"
                    min={1}
                    max={31}
                    allowDecimal={false}
                    value={schedule.day_of_month ?? 31}
                    onChange={(v) => {
                      dirty.current = true;
                      setSchedule((s) => ({ ...s, day_of_month: Number(v) }));
                    }}
                  />
                )}
                {schedule.frequency === 'weekly' && (
                  <Select
                    label="星期"
                    value={String(schedule.weekday ?? 0)}
                    data={Array.from('日一二三四五六').map((n, i) => ({
                      value: String(i),
                      label: '星期' + n,
                    }))}
                    onChange={(v) => {
                      dirty.current = true;
                      setSchedule((s) => ({ ...s, weekday: Number(v) }));
                    }}
                  />
                )}
                {schedule.frequency === 'yearly' && (
                  <Group>
                    <NumberInput
                      label="月份"
                      min={1}
                      max={12}
                      value={schedule.month ?? 2}
                      onChange={(v) => {
                        dirty.current = true;
                        setSchedule((s) => ({ ...s, month: Number(v) }));
                      }}
                    />
                    <NumberInput
                      label="日期"
                      min={1}
                      max={31}
                      value={schedule.day ?? 29}
                      onChange={(v) => {
                        dirty.current = true;
                        setSchedule((s) => ({ ...s, day: Number(v) }));
                      }}
                    />
                  </Group>
                )}
                <TextInput
                  type="date"
                  label="開始日期"
                  aria-label="開始日期"
                  required
                  value={schedule.start_on}
                  onChange={(e) => {
                    const targetValue = e.currentTarget.value;
                    dirty.current = true;
                    setSchedule((s) => ({
                      ...s,
                      start_on: targetValue,
                    }));
                  }}
                />
                <TextInput
                  type="date"
                  label="結束日期（選填）"
                  aria-label="結束日期（選填）"
                  value={schedule.end_on ?? ''}
                  onChange={(e) => {
                    const targetValue = e.currentTarget.value;
                    dirty.current = true;
                    setSchedule((s) => ({
                      ...s,
                      end_on: targetValue || null,
                    }));
                  }}
                />
                <Checkbox
                  label="啟用規則"
                  checked={schedule.active}
                  onChange={(e) => {
                    const targetValue = e.currentTarget.checked;
                    dirty.current = true;
                    setSchedule((s) => ({
                      ...s,
                      active: targetValue,
                    }));
                  }}
                />
                <Checkbox
                  label="自動入帳（失敗留待確認）"
                  checked={schedule.auto_post}
                  onChange={(e) => {
                    const targetValue = e.currentTarget.checked;
                    dirty.current = true;
                    setSchedule((s) => ({
                      ...s,
                      auto_post: targetValue,
                    }));
                  }}
                />
                {schedule.start_on && (
                  <Text>
                    {frequencyPreview(
                      schedule,
                      editor?.rule &&
                        (
                          [
                            'frequency',
                            'interval',
                            'day_of_month',
                            'weekday',
                            'month',
                            'day',
                            'start_on',
                          ] as const
                        ).every((k) => schedule[k] === editor.rule![k])
                        ? editor.rule.next_on
                        : nextOccurrence(schedule),
                    )}
                  </Text>
                )}
                <Text size="sm">
                  下方重用快速／進階記帳；日期只作樣板試算，實際日期由排程決定。未手填匯率時，入帳依當日查詢。
                </Text>
              </Stack>
            )}
            <div className="recurring-template">
              <Transactions
                key={editor.rule?.id ?? editor.occurrence?.id ?? 'new'}
                ledger={ledger}
                onDirtyChange={(v) => {
                  templateDirty.current = v;
                }}
                onBusyChange={(v) => {
                  working.current = v;
                }}
                requestDiscard={(fn) => setDiscard(() => fn)}
                onSaved={() => {
                  dirty.current = false;
                  setEditor(null);
                  notify(editor.occurrence ? '已更新當期' : '已儲存規則');
                  refreshed();
                }}
                onClose={close}
                draft={{
                  ...(initial ? { initial } : {}),
                  save: saveDraft,
                  label: editor.occurrence ? '儲存當期' : '儲存規則',
                  occurrence: !!editor.occurrence,
                }}
              />
            </div>
          </>
        )}
      </AdminEditor>
      <ConfirmDialog
        opened={deleting !== null}
        title="刪除週期規則"
        confirmLabel="確認刪除週期規則"
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          void act(async () => {
            await api(base + '/' + deleting, 'DELETE');
            setDeleting(null);
          }, '已刪除規則，已入帳交易保留')
        }
        busy={busy}
      >
        刪除規則與尚待入帳的當期；已入帳交易保留。
      </ConfirmDialog>
      <ConfirmDialog
        opened={discard !== null}
        title="放棄未儲存內容"
        confirmLabel="放棄修改"
        cancelLabel="繼續編輯"
        onCancel={() => setDiscard(null)}
        onConfirm={() => {
          discard?.();
          setDiscard(null);
        }}
      >
        尚未儲存的修改將遺失。
      </ConfirmDialog>
    </Stack>
  );
}
