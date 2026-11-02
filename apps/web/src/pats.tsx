// SPDX-License-Identifier: AGPL-3.0-only
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
  Card,
  Checkbox,
  MultiSelect,
  NumberInput,
  Stack,
  Text,
  Textarea,
  Modal,
} from '@mantine/core';
import { api, errorMessage } from './api';
interface Pat {
  id: string;
  token_prefix: string;
  scope: string;
  ledger_ids: string[] | null;
  mask_text: boolean;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
export function Pats() {
  const [rows, setRows] = useState<Pat[]>([]),
    [ledgers, setLedgers] = useState<{ value: string; label: string }[]>([]),
    [ids, setIds] = useState<string[]>([]),
    [all, setAll] = useState(true),
    [mask, setMask] = useState(true),
    [draft, setDraft] = useState(false),
    [days, setDays] = useState<string | number>(30),
    [secret, setSecret] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [revoking, setRevoking] = useState<string | null>(null);
  useEffect(() => {
    void run(load).finally(() => setLoading(false));
  }, []);
  async function load() {
    setRows(await api<Pat[]>('/api/pats'));
    setLedgers(
      (await api<{ id: string; name: string }[]>('/api/ledgers')).map((l) => ({
        value: l.id,
        label: l.name,
      })),
    );
  }
  async function run(op: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await op();
    } catch (e) {
      setRevoking(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack className="pat-management">
      <h2>MCP 存取權杖</h2>
      <Stack>
        <Text>權杖只顯示一次，請存放於安全位置；不會保存在瀏覽器。</Text>
        {error && <ErrorState message={error} retry={() => void run(load)} />}
        {loading && <LoadingState label="載入權杖" />}
        {busy && !loading && <LoadingState label="更新權杖" hasData />}
        <Checkbox
          label="允許 AI 建立待確認草稿"
          checked={draft}
          onChange={(e) => setDraft(e.currentTarget.checked)}
        />
        {draft && (
          <Text className="recurring-warning">
            AI 可建立待確認草稿，不能直接入帳
          </Text>
        )}
        <NumberInput
          label="有效天數"
          min={1}
          max={90}
          allowDecimal={false}
          value={days}
          onChange={setDays}
        />
        <Checkbox
          label="允許所有自己的帳本"
          checked={all}
          onChange={(e) => setAll(e.currentTarget.checked)}
        />
        {!all && (
          <MultiSelect
            searchable
            label="允許的帳本"
            data={ledgers}
            value={ids}
            onChange={setIds}
          />
        )}
        <Checkbox
          label="遮罩摘要、發票號碼、收付人與專案名稱"
          checked={mask}
          onChange={(e) => setMask(e.currentTarget.checked)}
        />
        <Button
          loading={busy}
          disabled={!all && !ids.length}
          onClick={() =>
            void run(async () => {
              setSecret('');
              const created = await api<Pat & { token: string }>(
                '/api/pats',
                'POST',
                {
                  expires_in_days: Number(days),
                  ledger_ids: all ? null : ids,
                  mask_text: mask,
                  scope: draft ? 'draft' : 'read',
                },
              );
              setSecret(created.token);
              await load();
              notify(draft ? '已建立草稿權杖' : '已建立唯讀權杖');
            })
          }
        >
          {draft ? '建立草稿權杖' : '建立唯讀權杖'}
        </Button>
        {secret && (
          <Modal
            opened
            onClose={() => setSecret('')}
            title="請立即保存，只顯示這一次"
            centered
            closeButtonProps={{ 'aria-label': '關閉權杖', size: 44 }}
          >
            <Stack>
              <Textarea
                label="新權杖"
                value={secret}
                readOnly
                autosize
                styles={{ input: { overflowWrap: 'anywhere' } }}
              />
              <Button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(secret)
                    .then(() => notify('已複製權杖'))
                    .catch(() => notify('無法自動複製，請選取權杖手動複製'));
                }}
              >
                複製權杖
              </Button>
              <Button onClick={() => setSecret('')}>我已保存，隱藏權杖</Button>
            </Stack>
          </Modal>
        )}
        {rows.map((row) => (
          <Card withBorder key={row.id}>
            <Stack gap="xs">
              <Text>
                {row.token_prefix}… ·{' '}
                {row.scope === 'draft' ? '草稿（包含唯讀）' : '唯讀'}
              </Text>
              <Text>
                到期：{new Date(row.expires_at).toLocaleString('zh-TW')}
              </Text>
              <Text>
                最後使用：
                {row.last_used_at
                  ? new Date(row.last_used_at).toLocaleString('zh-TW')
                  : '尚未使用'}
              </Text>
              <Text style={{ overflowWrap: 'anywhere' }}>
                帳本範圍：
                {row.ledger_ids === null
                  ? '全部帳本'
                  : row.ledger_ids
                      .map(
                        (id) =>
                          ledgers.find((l) => l.value === id)?.label ?? id,
                      )
                      .join('、')}
              </Text>
              <Text>遮罩：{row.mask_text ? '開啟' : '關閉'}</Text>
              <Button
                disabled={
                  !!row.revoked_at || new Date(row.expires_at) <= new Date()
                }
                loading={busy}
                onClick={() => setRevoking(row.id)}
              >
                {row.revoked_at ? '已撤銷' : '撤銷權杖'}
              </Button>
            </Stack>
          </Card>
        ))}
      </Stack>
      <ConfirmDialog
        opened={revoking !== null}
        title="撤銷權杖"
        confirmLabel="確認撤銷權杖"
        onCancel={() => setRevoking(null)}
        busy={busy}
        onConfirm={() =>
          void run(async () => {
            setSecret('');
            await api('/api/pats/' + revoking + '/revoke', 'POST');
            await load();
            setRevoking(null);
            notify('已撤銷權杖');
          })
        }
      >
        撤銷後，使用此權杖的 MCP 連線將立即失效。
      </ConfirmDialog>
      {!loading && !error && !rows.length && (
        <EmptyState title="尚無存取權杖">
          建立唯讀權杖後，可供 MCP 讀取你允許的帳本。
        </EmptyState>
      )}
    </Stack>
  );
}
