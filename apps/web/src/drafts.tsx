// SPDX-License-Identifier: AGPL-3.0-only
import { generatedAt } from './report-common';
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Group, Modal, Select, Stack, Text } from '@mantine/core';
import type { Ledger, Item } from '@finmichi/core/catalog-schemas';
import type { TransactionDraft, DraftPage } from '@finmichi/core/draft-schemas';
import type {
  TransactionInput,
  Preview,
} from '@finmichi/core/transaction-schemas';
import { api, errorMessage } from './api';
import { Transactions } from './transactions';
import { AdminEditor } from './design/admin-editor';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  notify,
} from './design/feedback';
import { guardNavigation, openEntry } from './design/location';
import { formatMoney, formatRate } from './design/format';
import { add } from './design/display-math';
const labels = {
  pending: '待確認',
  approved: '已入帳',
  rejected: '已拒絕',
  expired: '已到期',
};
const total = (p: Preview) =>
  add(
    p.entries
      .filter((e) => !e.base_amount.startsWith('-'))
      .map((e) => e.base_amount),
  );
export function Drafts({ ledger }: { ledger: Ledger }) {
  const base = `/api/ledgers/${ledger.id}/drafts`;
  const [page, setPage] = useState<DraftPage | null>(null),
    [items, setItems] = useState<Item[]>([]),
    [filter, setFilter] = useState('pending'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [view, setView] = useState<TransactionDraft | null>(null),
    [edit, setEdit] = useState<TransactionDraft | null>(null),
    [action, setAction] = useState<{
      row: TransactionDraft;
      kind: 'approve' | 'reject';
    } | null>(null),
    [discard, setDiscard] = useState<(() => void) | null>(null),
    [confirmation, setConfirmation] = useState<{
      data: TransactionInput;
      resolve: (v: boolean) => void;
    } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const request = useRef(0);
  const dirty = useRef(false),
    working = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  async function load(more = false) {
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    try {
      const q = new URLSearchParams();
      if (filter === 'pending') q.set('status', 'pending');
      if (more && page?.next_cursor) q.set('cursor', page.next_cursor);
      const [next, catalog] = await Promise.all([
        api<DraftPage>(base + '?' + q),
        api<Item[]>(`/api/ledgers/${ledger.id}/items?include_archived=true`),
      ]);
      if (ticket !== request.current) return;
      setPage((old) =>
        more && old ? { ...next, items: [...old.items, ...next.items] } : next,
      );
      setItems(catalog);
    } catch (e) {
      if (ticket === request.current) setError(errorMessage(e));
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [ledger.id, filter]);
  useEffect(
    () =>
      guardNavigation((proceed) => {
        if (working.current) return;
        if (edit && dirty.current) setDiscard(() => proceed);
        else proceed();
      }),
    [edit],
  );
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (edit && dirty.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [edit]);
  function close() {
    if (working.current) return;
    if (dirty.current) setDiscard(() => () => setEdit(null));
    else setEdit(null);
  }
  async function refreshed(message: string) {
    dirty.current = false;
    setEdit(null);
    notify(message);
    await load();
    window.dispatchEvent(new Event('ledger:catalogs-changed'));
    window.dispatchEvent(new Event('ledger:transactions-changed'));
    heading.current?.focus();
  }
  async function decide() {
    if (!action) return;
    setBusy(true);
    setError('');
    try {
      await api(base + '/' + action.row.id + '/' + action.kind, 'POST', {});
      const message =
        action.kind === 'approve'
          ? '草稿已核准並入帳。'
          : '草稿已拒絕，不會入帳。';
      setAction(null);
      await refreshed(message);
    } catch (e) {
      setError(errorMessage(e));
      setAction(null);
    } finally {
      setBusy(false);
    }
  }
  function preview(row: TransactionDraft) {
    return (
      <Stack gap="xs">
        <Text>
          {row.payload.occurred_on} ·{' '}
          {formatMoney(total(row.preview), ledger.base_currency)}
        </Text>
        <Text style={{ overflowWrap: 'anywhere' }}>
          {row.payload.memo || '無摘要'}
        </Text>
        <Text style={{ overflowWrap: 'anywhere' }}>
          AI 備註：{row.note || '無'}
        </Text>
        {row.preview.entries.map((e, i) => (
          <div key={i} className="panel draft-leg">
            <Text>
              {items.find((v) => v.id === e.item_id)?.name ?? '科目已不存在'}
            </Text>
            <Text className="num" title={e.amount}>
              {formatMoney(e.amount, e.currency)}
            </Text>
            {e.currency !== ledger.base_currency && (
              <Text title={e.exchange_rate}>
                有效匯率 {formatRate(e.exchange_rate)}
              </Text>
            )}
          </div>
        ))}
        {row.preview.warnings.length > 0 && (
          <p className="recurring-warning">
            有效匯率偏離參考匯率超過 5%，請確認分錄後再核准。
          </p>
        )}
        <Text size="sm">核准時會重新檢查金額、匯率、封存科目與關帳期間。</Text>
      </Stack>
    );
  }
  return (
    <Stack className="draft-management">
      <h2 ref={heading} tabIndex={-1}>
        AI 交易草稿
      </h2>
      <Text>
        AI 只能提出草稿；由你在這裡確認後才會入帳。14 天未處理將自動到期。
      </Text>
      {page && (
        <Text>
          待確認 {page.pending_count} 筆 · 單筆本位幣上限{' '}
          {formatMoney(page.max_base_amount, ledger.base_currency)}
        </Text>
      )}
      <Select
        label="草稿狀態"
        value={filter}
        onChange={(v) => setFilter(v ?? 'pending')}
        data={[
          { value: 'pending', label: '待確認' },
          { value: 'all', label: '全部草稿' },
        ]}
        allowDeselect={false}
      />
      {busy && <LoadingState label="載入 AI 草稿" hasData={!!page} />}
      {error && <ErrorState message={error} retry={() => void load()} />}
      {!busy && !error && page?.items.length === 0 && (
        <EmptyState title="目前沒有草稿">
          AI 建立的草稿會出現在這裡，核准後才會寫入交易。
        </EmptyState>
      )}
      {page?.items.map((row) => (
        <Card withBorder key={row.id}>
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={600}>{row.payload.occurred_on}</Text>
              <Text>{labels[row.status]}</Text>
            </Group>
            <Text className="num">
              {formatMoney(total(row.preview), ledger.base_currency)}
            </Text>
            <Text lineClamp={2} style={{ overflowWrap: 'anywhere' }}>
              {row.payload.memo || '無摘要'}
            </Text>
            <Text size="sm">
              來源權杖 {row.token_prefix ?? '已移除'} ·{' '}
              {generatedAt(row.created_at)}
            </Text>
            <Group gap="xs" className="draft-actions">
              <Button variant="default" mih={44} onClick={() => setView(row)}>
                檢視
              </Button>
              {row.status === 'pending' && (
                <>
                  <Button
                    variant="default"
                    mih={44}
                    aria-label={`修改草稿 ${row.id.slice(0, 8)}`}
                    onClick={() => {
                      dirty.current = false;
                      setEdit(row);
                    }}
                  >
                    修改
                  </Button>
                  <Button
                    mih={44}
                    disabled={busy}
                    aria-label={`核准草稿 ${row.id.slice(0, 8)}`}
                    onClick={() => setAction({ row, kind: 'approve' })}
                  >
                    核准
                  </Button>
                  <Button
                    variant="default"
                    mih={44}
                    disabled={busy}
                    aria-label={`拒絕草稿 ${row.id.slice(0, 8)}`}
                    onClick={() => setAction({ row, kind: 'reject' })}
                  >
                    拒絕
                  </Button>
                </>
              )}
              {row.status === 'approved' && row.transaction_id && (
                <Button
                  variant="default"
                  mih={44}
                  onClick={() => openEntry(row.transaction_id!)}
                >
                  查看已入帳交易
                </Button>
              )}
            </Group>
          </Stack>
        </Card>
      ))}
      {page?.next_cursor && (
        <Button
          variant="default"
          mih={44}
          loading={busy}
          onClick={() => void load(true)}
        >
          載入更多草稿
        </Button>
      )}
      <Modal
        opened={!!view}
        onClose={() => setView(null)}
        title="檢視 AI 草稿"
        closeButtonProps={{ 'aria-label': '關閉草稿檢視', size: 44 }}
      >
        {view && preview(view)}
      </Modal>
      <AdminEditor
        opened={!!edit}
        title="修改 AI 草稿"
        busy={editBusy}
        onClose={close}
        desktopSize={420}
      >
        {edit && (
          <Transactions
            key={edit.id}
            ledger={ledger}
            onDirtyChange={(v) => {
              dirty.current = v;
            }}
            onBusyChange={(v) => {
              working.current = v;
              setEditBusy(v);
            }}
            requestDiscard={(fn) => setDiscard(() => fn)}
            onClose={close}
            onSaved={() => {
              void refreshed('修改後的草稿已核准並入帳。');
            }}
            draft={{
              initial: edit.payload,
              initialMode: 'advanced',
              label: '確認修改並核准',
              successMessage: '草稿已核准並入帳。',
              confirm: (data) =>
                new Promise((resolve) => setConfirmation({ data, resolve })),
              save: async (data) => {
                await api(base + '/' + edit.id + '/approve', 'POST', {
                  payload: data,
                });
              },
            }}
          />
        )}
      </AdminEditor>
      <ConfirmDialog
        opened={!!action}
        title={action?.kind === 'reject' ? '拒絕 AI 草稿' : '核准 AI 草稿'}
        confirmLabel={action?.kind === 'reject' ? '確認拒絕草稿' : '核准並入帳'}
        busy={busy}
        onCancel={() => setAction(null)}
        onConfirm={() => void decide()}
      >
        {action &&
          (action.kind === 'reject' ? (
            <Text>拒絕後這筆草稿不會入帳。</Text>
          ) : (
            preview(action.row)
          ))}
      </ConfirmDialog>
      <ConfirmDialog
        opened={!!confirmation}
        title="核准修改後的草稿"
        confirmLabel="核准並入帳"
        onCancel={() => {
          confirmation?.resolve(false);
          setConfirmation(null);
        }}
        onConfirm={() => {
          confirmation?.resolve(true);
          setConfirmation(null);
        }}
      >
        <Text>將以目前修改的日期、金額與分錄建立交易，確定核准並入帳？</Text>
      </ConfirmDialog>
      <ConfirmDialog
        opened={!!discard}
        title="未儲存內容"
        confirmLabel="捨棄變更"
        cancelLabel="繼續編輯"
        onCancel={() => setDiscard(null)}
        onConfirm={() => {
          const go = discard;
          setDiscard(null);
          dirty.current = false;
          go?.();
        }}
      >
        <Text>有未儲存的變更，確定要捨棄嗎？</Text>
      </ConfirmDialog>
    </Stack>
  );
}
