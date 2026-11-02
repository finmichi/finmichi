// SPDX-License-Identifier: AGPL-3.0-only
import { AdminEditor } from './design/admin-editor';
import { ReportTree } from './report-common';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  notify,
} from './design/feedback';
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import type { Item, Ledger } from '@finmichi/core/catalog-schemas';
import { api, errorMessage } from './api';
const kinds = [
  { value: 'asset', label: '資產' },
  { value: 'liability', label: '負債' },
  { value: 'income', label: '收入' },
  { value: 'expense', label: '支出' },
  { value: 'equity', label: '權益' },
];
const flags = [
  'non_operating',
  'fixed',
  'credit_card',
  'loan',
  'securities',
] as const;
const flagLabels = {
  non_operating: '業外',
  fixed: '固定性',
  credit_card: '信用卡',
  loan: '貸款',
  securities: '證券',
};
const initialFlags = {
  non_operating: false,
  fixed: false,
  credit_card: false,
  loan: false,
  securities: false,
};
export function Items({ ledger }: { ledger: Ledger }) {
  const [opened, setOpened] = useState(false),
    [search, setSearch] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const [items, setItems] = useState<Item[]>([]),
    [includeArchived, setIncludeArchived] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null),
    [name, setName] = useState('');
  const [kind, setKind] = useState('asset'),
    [currency, setCurrency] = useState(ledger.base_currency),
    [parent, setParent] = useState<string | null>(null);
  const [values, setValues] = useState(initialFlags),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const endpoint = `/api/ledgers/${ledger.id}/items`;
  function reset() {
    setError('');
    setEditing(null);
    setName('');
    setKind('asset');
    setCurrency(ledger.base_currency);
    setParent(null);
    setValues(initialFlags);
  }
  async function refresh() {
    setItems(await api<Item[]>(endpoint + '?include_archived=true'));
  }
  useEffect(() => {
    let live = true;
    void api<Item[]>(endpoint + '?include_archived=true')
      .then((rows) => {
        if (live) setItems(rows);
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
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api(
        editing ? `${endpoint}/${editing.id}` : endpoint,
        editing ? 'PATCH' : 'POST',
        {
          name,
          parent_id: parent,
          ...values,
          ...(editing ? {} : { kind, currency }),
        },
      );
      await refresh();
      reset();
      setOpened(false);
      notify('已儲存科目');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function archive(item: Item) {
    setBusy(true);
    setError('');
    try {
      await api(`${endpoint}/${item.id}`, 'PATCH', {
        archived: !item.archived,
      });
      await refresh();
      if (editing?.id === item.id) reset();
      notify(item.archived ? '已取消封存科目' : '已封存科目');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const descendants = new Set<string>();
  if (editing) {
    const pending = [editing.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (descendants.has(id)) continue;
      descendants.add(id);
      pending.push(...items.filter((i) => i.parent_id === id).map((i) => i.id));
    }
  }
  return (
    <Stack>
      <div className="panel-heading">
        <h2>科目樹</h2>
        <Button
          onClick={() => {
            reset();
            setOpened(true);
          }}
        >
          新增科目
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
        label="搜尋科目"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      <Checkbox
        label="顯示封存科目"
        checked={includeArchived}
        onChange={(e) => setIncludeArchived(e.currentTarget.checked)}
      />
      {loading ? (
        <LoadingState label="載入科目" hasData={items.length > 0} />
      ) : null}
      {!loading && !error && !items.length && (
        <EmptyState title="尚無科目，請新增。">
          按新增科目建立資產、負債、收入或支出。
        </EmptyState>
      )}
      {busy && <LoadingState label="更新科目" hasData />}
      {items.length > 0 && (
        <section className="panel">
          <ReportTree
            key={search + includeArchived + items.length}
            defaultExpandRoots
            rows={items.filter(
              (i) =>
                (includeArchived || !i.archived) &&
                (!search ||
                  i.name
                    .toLocaleLowerCase()
                    .includes(search.toLocaleLowerCase())),
            )}
            columns={[
              {
                label: '類別／幣別',
                render: (i) => (
                  <span>
                    {kinds.find((k) => k.value === i.kind)?.label}／{i.currency}
                  </span>
                ),
              },
              {
                label: '旗標',
                render: (i) => (
                  <Group gap="xs">
                    {i.archived && <Badge color="gray">已封存</Badge>}
                    {flags
                      .filter((f) => i[f])
                      .map((f) => (
                        <Badge key={f} variant="outline">
                          {flagLabels[f]}
                        </Badge>
                      ))}
                  </Group>
                ),
              },
              {
                label: '操作',
                render: (item) => (
                  <Group>
                    <Button
                      size="xs"
                      variant="light"
                      aria-label={'編輯 ' + item.name}
                      disabled={busy}
                      onClick={() => {
                        setEditing(item);
                        setName(item.name);
                        setKind(item.kind);
                        setCurrency(item.currency);
                        setParent(item.parent_id);
                        setValues({
                          non_operating: item.non_operating,
                          fixed: item.fixed,
                          credit_card: item.credit_card,
                          loan: item.loan,
                          securities: item.securities ?? false,
                        });
                        setOpened(true);
                      }}
                    >
                      編輯
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      aria-label={
                        (item.archived ? '取消封存' : '封存') + ' ' + item.name
                      }
                      disabled={busy}
                      onClick={() => void archive(item)}
                    >
                      {item.archived ? '取消封存' : '封存'}
                    </Button>
                  </Group>
                ),
              },
            ]}
          />
        </section>
      )}
      <AdminEditor
        opened={opened}
        title={editing ? '編輯科目' : '新增科目'}
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
            <Text size="sm">{editing ? '編輯科目資料' : '填寫新科目資料'}</Text>
            <TextInput
              label="科目名稱"
              data-autofocus
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              disabled={busy}
            />
            <Select
              label="科目類型"
              required
              value={kind}
              data={kinds}
              onChange={(v) => {
                const next = v ?? 'asset';
                setKind(next);
                if (items.find((i) => i.id === parent)?.kind !== next)
                  setParent(null);
              }}
              disabled={busy || Boolean(editing)}
            />
            <TextInput
              label="科目幣別"
              required
              pattern="[A-Z]{3}"
              minLength={3}
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
              disabled={busy || Boolean(editing)}
            />
            <Select
              label="上層科目"
              description="父子類型須相同，幣別可不同。"
              clearable
              placeholder="無（根科目）"
              value={parent}
              onChange={setParent}
              disabled={busy}
              data={items
                .filter((i) => i.kind === kind && !descendants.has(i.id))
                .map((i) => ({
                  value: i.id,
                  label: `${i.name} (${kinds.find((k) => k.value === i.kind)?.label} / ${i.currency}${i.archived ? '，已封存' : ''})`,
                }))}
            />
            {flags.map((flag) => (
              <Checkbox
                key={flag}
                label={flagLabels[flag]}
                checked={values[flag]}
                onChange={(e) =>
                  setValues({ ...values, [flag]: e.currentTarget.checked })
                }
                disabled={
                  busy ||
                  (flag === 'securities' &&
                    (kind !== 'asset' ||
                      currency !== 'TWD' ||
                      ledger.base_currency !== 'TWD'))
                }
              />
            ))}
            {ledger.base_currency !== 'TWD' && (
              <Text size="sm">股票功能目前僅支援本位幣為新臺幣的帳本</Text>
            )}
            <Text size="sm" c="dimmed">
              類型與幣別建立後固定；封存僅影響此科目，不刪除歷史紀錄或子科目。
            </Text>
            <Group>
              <Button type="submit" disabled={!name.trim()} loading={busy}>
                儲存科目
              </Button>
              {editing && (
                <Button
                  variant="subtle"
                  disabled={busy}
                  onClick={() => {
                    reset();
                    setOpened(false);
                  }}
                >
                  取消科目編輯
                </Button>
              )}
            </Group>
          </Stack>
        </form>
      </AdminEditor>
    </Stack>
  );
}
