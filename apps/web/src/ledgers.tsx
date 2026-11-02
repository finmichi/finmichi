// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import { api, errorMessage } from './api';
import { useWorkspace } from './design/workspace';
import { todayTaipei } from './design/display-math';
import { AdminEditor } from './design/admin-editor';
import { DataReset } from './data-reset';
import {
  EmptyState,
  ErrorState,
  ConfirmDialog,
  notify,
} from './design/feedback';
export function Ledgers() {
  const { ledgers, current, refresh, select } = useWorkspace();
  const [editing, setEditing] = useState<Ledger | null>(null),
    [opened, setOpened] = useState(false),
    [name, setName] = useState(''),
    [currency, setCurrency] = useState('TWD'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false);
  function edit(row: Ledger | null) {
    setEditing(row);
    setName(row?.name ?? '');
    setCurrency(row?.base_currency ?? 'TWD');
    setError('');
    setOpened(true);
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      const row = await api<Ledger>(
        editing ? `/api/ledgers/${editing.id}` : '/api/ledgers',
        editing ? 'PATCH' : 'POST',
        { name, base_currency: currency },
      );
      await refresh(row.id);
      setOpened(false);
      notify(editing ? '已儲存帳本' : '已新增帳本');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ledgers/${editing.id}`, 'DELETE');
      await refresh();
      setDeleting(false);
      setOpened(false);
      notify('已刪除空帳本');
    } catch (e) {
      setDeleting(false);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack>
      <div className="panel-heading">
        <h2>帳本與關帳</h2>
        <Button onClick={() => edit(null)}>新增帳本</Button>
      </div>
      <Text size="sm">
        關帳日（含）以前的交易不可新增、修改或刪除；日期以臺北時間為準。
      </Text>
      {!ledgers.length && (
        <EmptyState title="尚無帳本">
          新增第一本帳本，開始管理科目與記帳。
        </EmptyState>
      )}
      <div className="admin-records">
        {ledgers.map((row) => (
          <section className="panel admin-record" key={row.id}>
            <h3>{row.name}</h3>
            <Text>本位幣：{row.base_currency}</Text>
            <Text>關帳日：{row.locked_until ?? '未關帳'}</Text>
            <LedgerLock row={row} refresh={() => refresh()} />
            <Group>
              <Button
                variant="light"
                onClick={() => select(row.id)}
                disabled={row.id === current?.id}
              >
                {row.id === current?.id ? '目前帳本' : '切換帳本'}
              </Button>
              <Button variant="subtle" onClick={() => edit(row)}>
                {row.id === current?.id
                  ? '管理目前帳本'
                  : '編輯帳本 ' + row.name}
              </Button>
            </Group>
            <DataReset ledger={row} />
          </section>
        ))}
      </div>
      <AdminEditor
        opened={opened}
        title={editing ? '編輯帳本' : '新增帳本'}
        onClose={() => setOpened(false)}
        busy={busy}
      >
        {error && <ErrorState message={error} />}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Stack>
            <TextInput
              label="帳本名稱"
              data-autofocus
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              disabled={busy}
            />
            <TextInput
              label="本位幣"
              description="3 位大寫幣別；有資料後不可變更。"
              required
              pattern="[A-Z]{3}"
              minLength={3}
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
              disabled={busy}
            />
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              儲存帳本
            </Button>
            {editing && (
              <>
                <Text>僅能刪除空帳本；已有資料時會拒絕。</Text>
                <Button
                  color="red"
                  variant="light"
                  onClick={() => setDeleting(true)}
                  disabled={busy}
                >
                  刪除空帳本
                </Button>
              </>
            )}
          </Stack>
        </form>
      </AdminEditor>
      <ConfirmDialog
        opened={deleting}
        title="刪除空帳本"
        confirmLabel="確認刪除空帳本"
        cancelLabel="保留帳本"
        onCancel={() => setDeleting(false)}
        onConfirm={() => void remove()}
        busy={busy}
      >
        刪除後無法復原，已有科目或交易時會拒絕。
      </ConfirmDialog>
    </Stack>
  );
}

function LedgerLock({
  row,
  refresh,
}: {
  row: Ledger;
  refresh: () => Promise<void>;
}) {
  const [date, setDate] = useState(row.locked_until ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState(false);
  useEffect(() => {
    setDate(row.locked_until ?? '');
  }, [row.locked_until]);
  const next = date || null;
  const changed = next !== row.locked_until;
  const unlocking =
    row.locked_until !== null && (next === null || next < row.locked_until);
  async function save(confirmed = false) {
    if (busy) return;
    setError('');
    if (unlocking && !confirmed) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    try {
      await api(`/api/ledgers/${row.id}/lock`, 'PATCH', {
        locked_until: next,
        ...(confirmed ? { confirm_unlock: true } : {}),
      });
      setConfirm(false);
      await refresh();
      notify(unlocking ? '已解鎖關帳' : '已儲存關帳日');
    } catch (e) {
      setConfirm(false);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form
        aria-label={'關帳設定 ' + row.name}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="xs">
          <TextInput
            type="date"
            label="關帳日"
            aria-label={'關帳日 ' + row.name}
            max={todayTaipei()}
            min="0001-01-01"
            value={date}
            onChange={(e) => setDate(e.currentTarget.value)}
            disabled={busy}
            description="留空表示未關帳；往前移或清除需確認解鎖。"
          />
          {error && <ErrorState message={error} retry={() => void save()} />}
          <Group>
            <Button
              type="submit"
              loading={busy}
              disabled={!changed}
              aria-label={'儲存關帳日 ' + row.name}
            >
              儲存關帳日
            </Button>
            <Button
              type="button"
              variant="subtle"
              disabled={busy || !date}
              onClick={() => {
                setDate('');
                setError('');
              }}
              aria-label={'清除關帳日 ' + row.name}
            >
              清除
            </Button>
          </Group>
        </Stack>
      </form>
      <ConfirmDialog
        opened={confirm}
        title="解鎖關帳"
        confirmLabel="確認解鎖關帳"
        cancelLabel="保留關帳"
        onCancel={() => setConfirm(false)}
        onConfirm={() => void save(true)}
        busy={busy}
      >
        {next
          ? `解鎖後，${next} 之後到原關帳日 ${row.locked_until}（含）的交易可再修改。`
          : `解鎖後，原關帳日 ${row.locked_until}（含）以前的交易可再修改。`}
      </ConfirmDialog>
    </>
  );
}
