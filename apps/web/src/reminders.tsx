// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button, Drawer, Group, Stack, Switch, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconBell } from '@tabler/icons-react';
import type {
  Reminder,
  RemindersResult,
  ReminderSettings,
} from '@finmichi/core/reminder-schemas';
import {
  reminderSettingsSchema,
  reminderTypes,
} from '@finmichi/core/reminder-schemas';
import { api, errorMessage } from './api';
import { navigate, guardNavigation } from './design/location';
import { useTransactionRevision } from './design/data-revision';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ConfirmDialog,
  notify,
} from './design/feedback';
const refresh = () =>
  window.dispatchEvent(new Event('ledger:reminders-changed'));
const openPanel = () =>
  window.dispatchEvent(new Event('ledger:reminders-open'));
function useReminders(ledger: string | undefined) {
  const [data, setData] = useState<RemindersResult | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const changed = useTransactionRevision();
  useEffect(() => {
    const f = () => setRevision((v) => v + 1);
    window.addEventListener('ledger:reminders-changed', f);
    window.addEventListener('focus', f);
    window.addEventListener('ledger:catalogs-changed', f);
    const timer = window.setInterval(f, 60000);
    return () => {
      window.removeEventListener('ledger:reminders-changed', f);
      window.removeEventListener('focus', f);
      window.removeEventListener('ledger:catalogs-changed', f);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    setData(null);
  }, [ledger]);
  useEffect(() => {
    let live = true;
    setError('');
    if (ledger)
      void api<RemindersResult>(`/api/ledgers/${ledger}/reminders`)
        .then((r) => {
          if (live) setData(r);
        })
        .catch((e) => {
          if (live) setError(errorMessage(e));
        });
    return () => {
      live = false;
    };
  }, [ledger, revision, changed]);
  return { data, error, retry: () => setRevision((v) => v + 1) };
}
function ReminderRows({
  items,
  ledger,
  onSelect,
}: {
  items: Reminder[];
  ledger: string;
  onSelect?: () => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function select(r: Reminder) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/ledgers/${ledger}/reminders/read`, 'POST', {
        items: [{ key: r.key, fingerprint: r.fingerprint }],
      });
      refresh();
      onSelect?.();
      navigate(r.href);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && <ErrorState message={error} />}
      <ul className="reminder-list">
        {items.map((r) => (
          <li key={r.key} data-reminder-read={r.read}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void select(r)}
            >
              <strong>
                {!r.read && <span aria-label="未讀">● </span>}
                {r.title}
              </strong>
              <span className={r.overdue_days > 0 ? 'finance-warning' : ''}>
                {r.detail}
              </span>
              <small>
                {r.date} · {r.read ? '已讀' : '未讀'}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
export function ReminderBell({ ledger }: { ledger: string | undefined }) {
  const { data, error, retry } = useReminders(ledger),
    [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [writeError, setWriteError] = useState('');
  const mobile = useMediaQuery('(max-width:899px)');
  useEffect(() => {
    const f = () => setOpened(true);
    window.addEventListener('ledger:reminders-open', f);
    return () => window.removeEventListener('ledger:reminders-open', f);
  }, []);
  useEffect(() => {
    setOpened(false);
    setWriteError('');
  }, [ledger]);
  const count = data?.unread_count ?? 0;
  return (
    <>
      <button
        type="button"
        className="reminder-bell"
        disabled={!ledger}
        aria-label={`提醒，${count} 筆未讀`}
        onClick={() => setOpened(true)}
      >
        <IconBell size={20} />
        {count > 0 && <span>{count > 99 ? '99+' : count}</span>}
      </button>
      <Drawer
        opened={opened}
        onClose={() => setOpened(false)}
        title="提醒中心"
        position="right"
        size={mobile ? '100%' : 440}
        closeButtonProps={{ 'aria-label': '關閉提醒中心' }}
      >
        <Stack>
          <Group>
            <Button
              disabled={!data || busy || !count}
              onClick={() => {
                if (!ledger) return;
                setBusy(true);
                setWriteError('');
                void api(`/api/ledgers/${ledger}/reminders/read`, 'POST', {
                  all: true,
                })
                  .then(() => {
                    refresh();
                    notify('已標記目前所有提醒為已讀。');
                  })
                  .catch((e) => setWriteError(errorMessage(e)))
                  .finally(() => setBusy(false));
              }}
            >
              全部標為已讀
            </Button>
            <Button
              variant="subtle"
              onClick={() => {
                setOpened(false);
                navigate('/admin/reminders');
              }}
            >
              提醒設定
            </Button>
          </Group>
          {writeError && <ErrorState message={writeError} />}
          {error ? (
            <ErrorState retry={retry} message={error} />
          ) : !data ? (
            <LoadingState />
          ) : !data.items.length ? (
            <EmptyState title="目前沒有提醒">
              設定的範圍內沒有待處理項目。
            </EmptyState>
          ) : (
            ledger && (
              <ReminderRows
                ledger={ledger}
                items={data.items}
                onSelect={() => setOpened(false)}
              />
            )
          )}
        </Stack>
      </Drawer>
    </>
  );
}
export function ReminderOverview({ ledger }: { ledger: string }) {
  const { data, error, retry } = useReminders(ledger);
  return (
    <section aria-label="待處理提醒" className="reminder-overview">
      <Group justify="space-between">
        <h3>待處理提醒</h3>
        <Button variant="subtle" onClick={openPanel}>
          查看全部
        </Button>
      </Group>
      {error ? (
        <ErrorState retry={retry} message={error} />
      ) : !data ? (
        <LoadingState />
      ) : data.items.length ? (
        <ReminderRows ledger={ledger} items={data.items.slice(0, 3)} />
      ) : (
        <p>目前沒有待處理提醒。</p>
      )}
    </section>
  );
}
const labels = {
  deposit: '定存到期',
  card: '信用卡繳款',
  loan: '貸款繳款',
  recurring: '週期待確認',
  draft: 'AI 草稿',
  market: '行情過期',
};
export function ReminderSettingsPage({ ledger }: { ledger: string }) {
  const [form, setForm] = useState<ReminderSettings | null>(null),
    [baseline, setBaseline] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<(() => void) | null>(null),
    [revision, setRevision] = useState(0);
  const dirty = form !== null && JSON.stringify(form) !== baseline;
  useEffect(() => {
    let live = true;
    setError('');
    void api<ReminderSettings>(`/api/ledgers/${ledger}/reminders/settings`)
      .then((r) => {
        if (live) {
          setForm(r);
          setBaseline(JSON.stringify(r));
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [ledger, revision]);
  useEffect(
    () =>
      guardNavigation((proceed) => {
        if (busy) return;
        if (dirty) setPending(() => proceed);
        else proceed();
      }),
    [busy, dirty],
  );
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);
  async function save() {
    const parsed = reminderSettingsSchema.safeParse(form);
    if (!parsed.success) {
      setError('提前天數須為 0–60，行情須為 1–20 個交易日。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(
        `/api/ledgers/${ledger}/reminders/settings`,
        'PUT',
        parsed.data,
      );
      setBaseline(JSON.stringify(parsed.data));
      refresh();
      notify('提醒設定已儲存。');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack>
      <h2>提醒設定</h2>
      <p>提醒即時計算；標記已讀後，內容變更會再次提醒。停用類型後不再顯示。</p>
      {error && (
        <ErrorState retry={() => setRevision((v) => v + 1)} message={error} />
      )}
      {!form ? (
        <LoadingState />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Stack>
            {reminderTypes.map((type) => {
              const enabled = `${type}_enabled` as const,
                days =
                  type === 'market'
                    ? 'market_trading_days'
                    : (`${type}_days` as const);
              return (
                <Group key={type} className="reminder-setting">
                  <Switch
                    label={labels[type]}
                    checked={form[enabled]}
                    onChange={(e) =>
                      setForm({ ...form, [enabled]: e.currentTarget.checked })
                    }
                  />
                  <TextInput
                    label={
                      type === 'market'
                        ? '落後交易日數'
                        : `${labels[type]}提前天數`
                    }
                    type="number"
                    min={type === 'market' ? 1 : 0}
                    max={type === 'market' ? 20 : 60}
                    value={form[days]}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        [days]:
                          e.currentTarget.value === ''
                            ? -1
                            : Number(e.currentTarget.value),
                      })
                    }
                  />
                </Group>
              );
            })}
            <Button type="submit" loading={busy} disabled={!dirty}>
              儲存提醒設定
            </Button>
          </Stack>
        </form>
      )}
      <ConfirmDialog
        opened={!!pending}
        title="捨棄未儲存的提醒設定？"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const f = pending;
          setPending(null);
          f?.();
        }}
        confirmLabel="捨棄變更"
      >
        尚未儲存的變更將會遺失。
      </ConfirmDialog>
    </Stack>
  );
}
