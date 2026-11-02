// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Stack, Text, TextInput } from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import { api, apiErrorMessage, errorMessage } from './api';
import {
  ConfirmDialog,
  ErrorState,
  LoadingState,
  notify,
} from './design/feedback';
import { useWorkspace } from './design/workspace';
import { resetLabels, resetText } from './data-reset-messages';
interface Safety {
  factory_reset: boolean;
  recent_auth: boolean;
  reauth_expires_at: string | null;
}
interface Preview {
  backup_token: string;
  expires_at: string;
  ledgers: Ledger[];
  counts: Record<string, number>;
}
export function DataReset({ ledger }: { ledger?: Ledger }) {
  const { refresh } = useWorkspace(),
    mode = ledger ? 'purge' : 'factory';
  const title = resetText[mode],
    base = ledger ? `/api/ledgers/${ledger.id}/purge` : '/api/factory-reset';
  const [opened, setOpened] = useState(false),
    [safety, setSafety] = useState<Safety | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [downloaded, setDownloaded] = useState<string[]>([]),
    [confirmation, setConfirmation] = useState(''),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!opened) return;
    let live = true;
    void api<{ safety: Safety }>('/api/me')
      .then((r) => {
        if (live) setSafety(r.safety);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [opened]);
  const recent =
    !!safety?.recent_auth &&
    !!safety.reauth_expires_at &&
    Date.parse(safety.reauth_expires_at) > now;
  const validPreview = !!preview && Date.parse(preview.expires_at) > now;
  const confirmationName = ledger
    ? (preview?.ledgers.find((row) => row.id === ledger.id)?.name ??
      ledger.name)
    : 'RESET';
  const ready =
    recent &&
    validPreview &&
    preview.ledgers.every((l) => downloaded.includes(l.id)) &&
    ack &&
    confirmation === confirmationName;
  function open() {
    setSafety(null);
    setPreview(null);
    setDownloaded([]);
    setConfirmation('');
    setAck(false);
    setError('');
    setNow(Date.now());
    setOpened(true);
  }
  async function prepare() {
    setBusy(true);
    setError('');
    setPreview(null);
    setDownloaded([]);
    setAck(false);
    try {
      setPreview(await api<Preview>(base + '-preview', 'POST', {}));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function download(row: Ledger) {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/ledgers/${row.id}/backup.json`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backup_token: preview.backup_token }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(apiErrorMessage(data.error));
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      const filename = response.headers
        .get('content-disposition')
        ?.match(/filename\*=UTF-8''([^;]+)/)?.[1];
      a.href = url;
      a.download = filename
        ? decodeURIComponent(filename)
        : 'finmichi-backup.json';
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      setDownloaded((old) => [...new Set([...old, row.id])]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!ready || !preview || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(base, 'POST', {
        backup_token: preview.backup_token,
        confirmation,
      });
      await refresh();
      setOpened(false);
      notify(ledger ? '已刪除帳本與全部資料' : '已完成原廠重置');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        color="red"
        variant="outline"
        onClick={open}
        aria-label={title + (ledger ? ' ' + ledger.name : '')}
      >
        {title}
      </Button>
      <ConfirmDialog
        opened={opened}
        title={title}
        confirmLabel={'確認' + title}
        cancelLabel="保留資料"
        closeLabel="關閉資料刪除確認"
        onCancel={() => setOpened(false)}
        onConfirm={() => void execute()}
        busy={busy}
        disabled={!ready}
      >
        <Stack gap="md" className="data-reset-steps">
          <Alert color="red" role="alert">
            {resetText.irreversible}。
            {ledger
              ? `將刪除「${confirmationName}」及全部所屬資料。`
              : '將刪除您所有帳本及存取權杖。'}
            {resetText.backupNotice}
          </Alert>
          {error && <ErrorState message={error} />}
          <section>
            <h3>1. 重新驗證身分 · {resetText.irreversible}</h3>
            {!safety ? (
              <LoadingState label="確認登入狀態" />
            ) : (
              <Text>
                {recent
                  ? '已完成重新驗證，僅在 5 分鐘內有效。'
                  : '請重新登入後再回到本頁預覽。'}
              </Text>
            )}
            <Button
              component="a"
              variant="light"
              href={
                '/auth/login?reauth=1&return_to=' +
                encodeURIComponent(ledger ? '/admin/ledgers' : '/admin/system')
              }
            >
              重新登入驗證身分
            </Button>
          </section>
          <section>
            <h3>2. 預覽刪除範圍 · {resetText.irreversible}</h3>
            <Button
              variant="default"
              onClick={() => void prepare()}
              disabled={!recent || busy}
            >
              預覽刪除範圍
            </Button>
            {preview && (
              <>
                <dl>
                  {Object.entries(preview.counts).map(([table, n]) => (
                    <div key={table}>
                      <dt>{resetLabels[table] ?? table}</dt>
                      <dd>{n} 筆</dd>
                    </div>
                  ))}
                </dl>
                {preview.ledgers.map((l) => (
                  <Text key={l.id}>
                    {l.name} · 關帳日：{l.locked_until ?? '未關帳'}
                    （不阻擋本次刪除）
                  </Text>
                ))}
                <Text size="sm">
                  授權僅有效 10 分鐘。預覽或備份後資料變更，須全部重新開始。
                </Text>
              </>
            )}
          </section>
          <section>
            <h3>3. 逐本下載 JSON · {resetText.irreversible}</h3>
            <Text>{resetText.exclusions}</Text>
            {preview?.ledgers.map((l) => (
              <Button
                key={l.id}
                variant="light"
                onClick={() => void download(l)}
                disabled={!recent || !validPreview || busy}
                aria-label={'下載刪除前備份 ' + l.name}
              >
                {downloaded.includes(l.id) ? '已下載，可重新下載' : '下載備份'}{' '}
                · {l.name}
              </Button>
            ))}
            {preview?.ledgers.length === 0 && (
              <Text>沒有帳本需要下載；仍須確認其餘資料的刪除範圍。</Text>
            )}
          </section>
          <section>
            <h3>4. 輸入確認文字 · {resetText.irreversible}</h3>
            <Text>{resetText.retained}</Text>
            <TextInput
              label={'請逐字輸入「' + confirmationName + '」'}
              value={confirmation}
              maxLength={200}
              disabled={busy}
              onChange={(e) => setConfirmation(e.currentTarget.value)}
            />
            <Checkbox
              label="我已確認全部 JSON 備份可讀取，並了解這個動作無法復原"
              checked={ack}
              disabled={
                busy ||
                !preview ||
                !preview.ledgers.every((l) => downloaded.includes(l.id))
              }
              onChange={(e) => setAck(e.currentTarget.checked)}
            />
            {safety && !recent && (
              <Text c="var(--warn)">
                身分驗證已逾時或尚未完成，請重新登入再開始。
              </Text>
            )}
            {preview && !validPreview && (
              <Text c="var(--warn)">備份授權已逾時，請重新預覽及下載。</Text>
            )}
          </section>
        </Stack>
      </ConfirmDialog>
    </>
  );
}
