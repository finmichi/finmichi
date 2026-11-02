// SPDX-License-Identifier: AGPL-3.0-only
import {
  ConfirmDialog,
  ErrorState,
  LoadingState,
  notify,
} from './design/feedback';
import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  FileInput,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { Ledger } from '@finmichi/core/catalog-schemas';
import { BACKUP_MAX_BYTES } from '@finmichi/core/backup-schemas';
import { api, apiErrorMessage, errorMessage } from './api';
const tableLabels: Record<string, string> = {
  securities: '證券',
  security_trades: '股票交易與股數紀錄',
  manual_prices: '手動價格',
  income_codes: '所得代碼',
  reminder_settings: '提醒設定',
  reminder_reads: '提醒已讀紀錄',
  fixed_deposits: '定存設定',
  deposit_postings: '定存入帳紀錄',
  dividends: '股利',
  dividend_components: '股利組成',
  recurring_rules: '週期規則',
  recurring_occurrences: '週期當期',
  budgets: '月預算',
  items: '科目',
  payees: '收付人',
  projects: '專案',
  memo_templates: '常用摘要',
  transactions: '交易',
  transaction_entries: '分錄',
  exchange_rates: '匯率',
  import_jobs: '匯入工作',
  import_source_records: '匯入來源追蹤',
};
interface Issue {
  table: string;
  index: number;
  field: string;
  code: string;
}
interface RestorePreview {
  mode: 'full' | 'structure';
  recurring_history: {
    deleted_rule_occurrences: number;
    posted_without_transaction: number;
    deleted_rule_transactions: number;
  };
  default_name: string;
  base_currency: string;
  locked_until: string | null;
  source_locked_until: string | null;
  counts: Record<string, number>;
  restore_counts: Record<string, number>;
  date_range: { from: string | null; to: string | null };
  dangling_targets: Record<string, number>;
  deleted_targets: Record<string, number>;
}
export function BackupRestore({
  ledger,
  onLedgerChange,
}: {
  ledger: Ledger;
  onLedgerChange?: (preferred?: string) => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null),
    [payload, setPayload] = useState<unknown>(null),
    [mode, setMode] = useState<'full' | 'structure'>('full'),
    [name, setName] = useState('');
  const [preview, setPreview] = useState<RestorePreview | null>(null),
    [reviewed, setReviewed] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [issues, setIssues] = useState<Issue[]>([]),
    [restored, setRestored] = useState<Ledger | null>(null);
  const signature = mode + '\0' + name;
  async function download() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/ledgers/${ledger.id}/backup.json`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(apiErrorMessage(data.error));
      }
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        a = globalThis.document.createElement('a');
      const filename = /filename\*=UTF-8''([^;]+)/i.exec(
        response.headers.get('content-disposition') ?? '',
      );
      a.download = filename
        ? decodeURIComponent(filename[1]!)
        : 'finmichi-backup.json';
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
      notify('已下載 JSON 備份');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    if (!file) return;
    setBusy(true);
    setError('');
    setIssues([]);
    setPreview(null);
    setReviewed('');
    setConfirmed(false);
    setRestored(null);
    try {
      if (file.size > BACKUP_MAX_BYTES)
        throw new Error('備份檔案最多 50 MiB。');
      let data = payload;
      if (data === null) {
        try {
          data = JSON.parse(
            (await file.text()).replace(/^\uFEFF/, ''),
          ) as unknown;
        } catch {
          throw new Error('這個檔案不是有效的 JSON，請重新選擇備份。');
        }
      }
      const q = new URLSearchParams({
        mode,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      const response = await fetch('/api/backup-restores/preview?' + q, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await response.json();
      if (!response.ok) {
        if (Array.isArray(result.issues))
          setIssues(
            result.issues
              .slice(0, 20)
              .filter((i: unknown): i is Issue =>
                Boolean(
                  i &&
                  typeof i === 'object' &&
                  'table' in i &&
                  typeof i.table === 'string' &&
                  'index' in i &&
                  typeof i.index === 'number' &&
                  'field' in i &&
                  typeof i.field === 'string' &&
                  'code' in i &&
                  typeof i.code === 'string',
                ),
              ),
          );
        throw new Error(apiErrorMessage(result.error));
      }
      const p = result as RestorePreview;
      setPayload(data);
      setPreview(p);
      setName(p.default_name);
      setReviewed(mode + '\0' + p.default_name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    setBusy(true);
    setError('');
    try {
      const q = new URLSearchParams({ mode, name: name.trim() });
      const result = await api<{ ledger: Ledger }>(
        '/api/backup-restores/confirm?' + q,
        'POST',
        payload,
      );
      setRestored(result.ledger);
      setConfirmOpen(false);
      notify('已還原為新帳本');
      setPreview(null);
      setReviewed('');
      setConfirmed(false);
      setFile(null);
      setPayload(null);
      setName('');
      await onLedgerChange?.();
    } catch (e) {
      setConfirmOpen(false);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack>
      <Title order={2}>帳本備份與還原</Title>
      {error && <ErrorState message={error} retry={() => void inspect()} />}
      {busy && <LoadingState label="處理備份與還原" hasData />}
      {issues.map((i, n) => (
        <Text key={n} c="red">
          {tableLabels[i.table] ?? i.table}第 {i.index + 1} 筆：
          {(
            {
              missing_reference: '找不到參照資料',
              ledger_mismatch: '資料不屬於備份帳本',
              duplicate_id: '識別碼重複',
              invalid_target_format: '來源追蹤格式不正確',
              source_job_missing: '找不到匯入工作',
              cycle: '科目父子形成循環',
            } as Record<string, string>
          )[i.code] ?? '參照資料有誤'}
          （{i.field}）
        </Text>
      ))}
      <Paper withBorder p="md">
        <Stack>
          <Title order={3}>下載目前帳本</Title>
          <Text>
            將「{ledger.name}
            」的完整資料備份下載到你的裝置，請自行保管。備份不包含登入資訊。
          </Text>
          <Button disabled={busy} onClick={() => void download()}>
            下載 JSON 備份
          </Button>
        </Stack>
      </Paper>
      <Paper withBorder p="md">
        <Stack>
          <Title order={3}>從檔案建立新帳本</Title>
          <Text>
            還原會建立新帳本，既有帳本保留。檔案最多 50 MiB、200,000
            筆交易；預覽不寫入資料。
          </Text>
          <FileInput
            label="JSON 備份檔案"
            accept=".json,application/json"
            value={file}
            disabled={busy}
            onChange={(f) => {
              setFile(f);
              setPayload(null);
              setPreview(null);
              setReviewed('');
              setConfirmed(false);
              setName('');
              setError('');
              setIssues([]);
              setRestored(null);
            }}
          />
          <Select
            label="還原模式"
            value={mode}
            disabled={busy}
            data={[
              { value: 'full', label: '完整還原（full）' },
              { value: 'structure', label: '僅還原結構（structure）' },
            ]}
            onChange={(v) => {
              if (v) {
                setMode(v as typeof mode);
                setPreview(null);
                setReviewed('');
                setConfirmed(false);
              }
            }}
          />
          <Text>
            {mode === 'full'
              ? '保留交易、原始分錄、匯率、匯入歷史、週期規則與當期、預算及關帳日。'
              : '建立科目、收付人、專案、常用摘要、預算與停用的週期規則；不包含交易、週期當期、匯率或匯入歷史，關帳日清空。'}
          </Text>
          <TextInput
            label="新帳本名稱"
            placeholder="預覽後自動帶入名稱，可修改"
            maxLength={200}
            value={name}
            disabled={busy}
            onChange={(e) => {
              setName(e.currentTarget.value);
              setConfirmed(false);
            }}
          />
          <Button disabled={!file || busy} onClick={() => void inspect()}>
            上傳並預覽 JSON
          </Button>
          {preview && (
            <>
              <Title order={3}>還原預覽</Title>
              <Text>新帳本：{preview.default_name}</Text>
              <Text>本位幣：{preview.base_currency}</Text>
              <Text>
                交易期間：{preview.date_range.from ?? '無交易'}～
                {preview.date_range.to ?? '無交易'}
              </Text>
              <Text>新帳本關帳日：{preview.locked_until ?? '未設定'}</Text>
              <Text>
                結構還原會保留預算與週期規則，規則預設停用，不還原任何週期當期。
              </Text>
              {preview.recurring_history && (
                <Text>
                  歷史參照：已刪除規則的當期{' '}
                  {preview.recurring_history.deleted_rule_occurrences}{' '}
                  筆、已入帳但交易已刪除{' '}
                  {preview.recurring_history.posted_without_transaction}{' '}
                  筆、來自已刪除規則的交易{' '}
                  {preview.recurring_history.deleted_rule_transactions}{' '}
                  筆。這些歷史會保留，不重建規則或交易。
                </Text>
              )}
              {Object.entries(preview.counts).map(([table, count]) => (
                <Text key={table}>
                  {tableLabels[table] ?? table}：檔案 {count} 筆，將還原{' '}
                  {preview.restore_counts[table]} 筆
                </Text>
              ))}
              {Object.entries(preview.dangling_targets)
                .filter(([, count]) => count > 0)
                .map(([table, count]) => (
                  <Alert key={table} color="yellow">
                    {tableLabels[table] ?? table}有 {count}{' '}
                    筆來源目標已不存在；完整還原時保留刪除標記，不會憑空建立資料。
                  </Alert>
                ))}
              {reviewed !== signature && (
                <Text role="status">名稱已變更，請重新預覽後再確認。</Text>
              )}
              <Checkbox
                label="我已核對檔案與名稱，確認建立新帳本"
                checked={confirmed}
                disabled={busy || reviewed !== signature}
                onChange={(e) => setConfirmed(e.currentTarget.checked)}
              />
              <Button
                disabled={
                  busy || !confirmed || reviewed !== signature || !name.trim()
                }
                onClick={() => setConfirmOpen(true)}
              >
                確認還原為新帳本
              </Button>
            </>
          )}
        </Stack>
      </Paper>
      {restored && (
        <Alert color="green" role="status">
          <Stack>
            <Text>已還原為新帳本「{restored.name}」，原帳本保留。</Text>
            {onLedgerChange && (
              <Button onClick={() => void onLedgerChange(restored.id)}>
                開啟還原帳本
              </Button>
            )}
          </Stack>
        </Alert>
      )}
      <ConfirmDialog
        opened={confirmOpen}
        title="還原為新帳本"
        confirmLabel="建立還原帳本"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void restore()}
        busy={busy}
      >
        將以{name}建立新的{mode === 'full' ? '完整' : '結構'}
        帳本；不覆蓋既有帳本。
      </ConfirmDialog>
    </Stack>
  );
}
