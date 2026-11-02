// SPDX-License-Identifier: AGPL-3.0-only
import { AdminEditor } from './design/admin-editor';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ConfirmDialog,
  notify,
} from './design/feedback';
import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import type { Ledger, NamedRecord } from '@finmichi/core/catalog-schemas';
import { api, errorMessage } from './api';
export function NamedRecords({
  ledger,
  resource,
  label,
}: {
  ledger: Ledger;
  resource: 'payees' | 'projects' | 'memo_templates';
  label: string;
}) {
  const [opened, setOpened] = useState(false),
    [search, setSearch] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const [memo, setMemo] = useState('');
  const endpoint = `/api/ledgers/${ledger.id}/${resource}`;
  const [rows, setRows] = useState<NamedRecord[]>([]),
    [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<NamedRecord | null>(null),
    [name, setName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void api<NamedRecord[]>(endpoint + '?include_archived=true')
      .then((r) => {
        if (live) setRows(r);
      })
      .finally(() => {
        if (live) setLoading(false);
      })
      .catch((e: unknown) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [endpoint, retry]);
  async function perform(operation: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await operation();
      setRows(await api<NamedRecord[]>(endpoint + '?include_archived=true'));
      setEditing(null);
      setName('');
      setMemo('');
      setDeleting(null);
      setOpened(false);
      notify('已更新' + label);
    } catch (e) {
      setDeleting(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function save() {
    return perform(() =>
      api(
        editing ? `${endpoint}/${editing.id}` : endpoint,
        editing ? 'PATCH' : 'POST',
        { name, ...(resource === 'memo_templates' ? { memo } : {}) },
      ),
    );
  }
  return (
    <Stack>
      <div className="panel-heading">
        <h2>{label}</h2>
        <Button
          onClick={() => {
            setError('');
            setEditing(null);
            setName('');
            setMemo('');
            setOpened(true);
          }}
        >
          新增{label}
        </Button>
      </div>
      {error && (
        <ErrorState
          message={error}
          retry={() => {
            setError('');
            setLoading(true);
            setRetry((v) => v + 1);
          }}
        />
      )}
      <TextInput
        label={'搜尋' + label}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      {loading && (
        <LoadingState label={'載入' + label} hasData={rows.length > 0} />
      )}
      {busy && <LoadingState label={'更新' + label} hasData />}
      <Checkbox
        label={`顯示封存${label}`}
        checked={showArchived}
        onChange={(e) => setShowArchived(e.currentTarget.checked)}
      />
      {!loading && !error && !rows.length && (
        <EmptyState title={'尚無' + label + '，請新增。'}>
          按新增建立資料，可供記帳時選取。
        </EmptyState>
      )}
      {!loading &&
        rows.length > 0 &&
        rows.filter(
          (r) =>
            (showArchived || !r.archived) &&
            r.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
        ).length === 0 && (
          <EmptyState title="沒有符合條件的資料">
            調整搜尋文字，或顯示已封存資料。
          </EmptyState>
        )}
      {rows
        .filter(
          (r) =>
            (showArchived || !r.archived) &&
            r.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
        )
        .map((r) => (
          <Paper key={r.id} withBorder p="sm">
            <Stack gap="xs">
              <Text style={{ overflowWrap: 'anywhere' }}>
                {r.name}
                {r.archived ? '（已封存）' : ''}
              </Text>
              {resource === 'memo_templates' && (
                <Text
                  size="sm"
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {r.memo}
                </Text>
              )}
              <Group gap="xs">
                <Button
                  variant="light"
                  aria-label={'編輯' + label + ' ' + r.name}
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setOpened(true);
                    setEditing(r);
                    setName(r.name);
                    setMemo(r.memo ?? '');
                    setDeleting(null);
                  }}
                >
                  編輯
                </Button>
                <Button
                  variant="subtle"
                  size="xs"
                  disabled={busy}
                  aria-label={
                    (r.archived ? '取消封存' : '封存') + label + ' ' + r.name
                  }
                  onClick={() =>
                    void perform(() =>
                      api(`${endpoint}/${r.id}`, 'PATCH', {
                        archived: !r.archived,
                      }),
                    )
                  }
                >
                  {r.archived ? '取消封存' : '封存'}
                </Button>
                <Button
                  color="red"
                  variant="subtle"
                  size="xs"
                  disabled={busy}
                  aria-label={'刪除' + label + ' ' + r.name}
                  onClick={() => setDeleting(r.id)}
                >
                  刪除
                </Button>
              </Group>
            </Stack>
          </Paper>
        ))}
      <ConfirmDialog
        opened={deleting !== null}
        title={'刪除' + label}
        confirmLabel={'確認刪除' + label}
        cancelLabel={'保留' + label}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting)
            void perform(() => api(`${endpoint}/${deleting}`, 'DELETE'));
        }}
        busy={busy}
      >
        確認刪除「{rows.find((r) => r.id === deleting)?.name}」？
        {resource === 'memo_templates'
          ? '已套用的交易摘要不會改變。'
          : '已有交易引用時會拒絕，請改用封存。'}
      </ConfirmDialog>
      <AdminEditor
        opened={opened}
        title={(editing ? '編輯' : '新增') + label}
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
              label={`${label}名稱`}
              data-autofocus
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              disabled={busy}
            />
            {resource === 'memo_templates' && (
              <Textarea
                label="摘要文字"
                required
                maxLength={2000}
                value={memo}
                onChange={(e) => setMemo(e.currentTarget.value)}
                disabled={busy}
                autosize
                minRows={3}
              />
            )}
            <Group>
              <Button
                type="submit"
                loading={busy}
                disabled={
                  !name.trim() ||
                  (resource === 'memo_templates' && !memo.trim())
                }
              >
                儲存{label}
              </Button>
              {editing && (
                <Button
                  variant="subtle"
                  disabled={busy}
                  onClick={() => {
                    setOpened(false);
                    setEditing(null);
                    setName('');
                    setMemo('');
                  }}
                >
                  取消{label}編輯
                </Button>
              )}
            </Group>
          </Stack>
        </form>
      </AdminEditor>
    </Stack>
  );
}
