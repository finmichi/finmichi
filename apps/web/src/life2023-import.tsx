// SPDX-License-Identifier: AGPL-3.0-only
import {
  ConfirmDialog,
  ErrorState,
  LoadingState,
  notify,
} from './design/feedback';
import { formatMoney } from './design/format';
import { useState, useEffect } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  FileInput,
  Paper,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { Ledger, Item, NamedRecord } from '@finmichi/core/catalog-schemas';
import type {
  Life2023Input,
  Life2023Preview,
  ItemChoice,
  NamedChoice,
} from '@finmichi/core/life2023-schemas';
import { api, errorMessage } from './api';
const kinds = [
  ['asset', '資產'],
  ['liability', '負債'],
  ['income', '收入'],
  ['expense', '支出'],
  ['equity', '權益'],
] as const;
const issues: Record<string, string> = {
  invalid_date: '日期無效，請用 YYYY/MM/DD 或 YYYY-MM-DD。',
  invalid_amount: '金額須為正數，最多 2 位小數。',
  invalid_text: '名稱或文字長度不正確。',
  invalid_column_count: '欄位數必須為 8。',
  mapping_required: '請明確選擇科目或新增類型。',
  foreign_currency_not_supported: '這個格式只支援本位幣科目。',
  duplicate_name: '名稱已存在，請改為對應既有科目或選擇其他名稱。',
  archived_resource: '已封存資料不能作為對應目標。',
  period_locked: '日期位於已關帳期間。',
};
export function Life2023Import({ ledger }: { ledger: Ledger }) {
  const [confirmOpen, setConfirmOpen] = useState(false),
    [loading, setLoading] = useState(true);
  const [file, setFile] = useState<File | null>(null),
    [encoding, setEncoding] = useState<Life2023Input['encoding']>('auto');
  const [raw, setRaw] = useState(''),
    [items, setItems] = useState<Item[]>([]),
    [payees, setPayees] = useState<NamedRecord[]>([]),
    [projects, setProjects] = useState<NamedRecord[]>([]);
  const [itemMappings, setItemMappings] = useState<Record<string, ItemChoice>>(
      {},
    ),
    [payeeMappings, setPayeeMappings] = useState<Record<string, NamedChoice>>(
      {},
    ),
    [projectMappings, setProjectMappings] = useState<
      Record<string, NamedChoice>
    >({});
  const [previewPage, setPreviewPage] = useState(0);
  const [preview, setPreview] = useState<Life2023Preview | null>(null),
    [reviewed, setReviewed] = useState(''),
    [skip, setSkip] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const base = `/api/ledgers/${ledger.id}`,
    body = {
      file_base64: raw,
      encoding,
      item_mappings: itemMappings,
      payee_mappings: payeeMappings,
      project_mappings: projectMappings,
      skip_invalid: skip,
    },
    signature = JSON.stringify(body);
  useEffect(() => {
    let live = true;
    void Promise.all([
      api<Item[]>(base + '/items'),
      api<NamedRecord[]>(base + '/payees'),
      api<NamedRecord[]>(base + '/projects'),
    ])
      .then(([i, p, j]) => {
        if (live) {
          setItems(i);
          setPayees(p);
          setProjects(j);
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [base]);
  async function upload() {
    if (!file) return;
    setBusy(true);
    setError('');
    setMessage('');
    setConfirmed(false);
    setPreviewPage(0);
    setPreview(null);
    setReviewed('');
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('CSV 檔案最多 4 MiB。');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const data = {
        file_base64: btoa(binary),
        encoding,
        item_mappings: {},
        payee_mappings: {},
        project_mappings: {},
        skip_invalid: false,
      };
      const result = await api<Life2023Preview>(
        base + '/imports/life2023/preview',
        'POST',
        data,
      );
      setRaw(data.file_base64);
      setItemMappings({});
      setPayeeMappings({});
      setProjectMappings({});
      setSkip(false);
      setPreview(result);
      setReviewed(JSON.stringify(data));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setBusy(true);
    setError('');
    setConfirmed(false);
    try {
      setPreviewPage(0);
      setPreview(
        await api<Life2023Preview>(
          base + '/imports/life2023/preview',
          'POST',
          body,
        ),
      );
      setReviewed(signature);
    } catch (e) {
      setError(errorMessage(e));
      setReviewed('');
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    setBusy(true);
    setError('');
    try {
      const saved = await api<{
        imported_count: number;
        skipped_count: number;
      }>(base + '/imports/life2023/confirm', 'POST', body);
      setMessage(
        `已匯入 ${saved.imported_count} 筆，略過 ${saved.skipped_count} 筆。`,
      );
      notify('已完成 CSV 匯入');
      setConfirmOpen(false);
      setReviewed('');
      setConfirmed(false);
      setPreview(null);
      setRaw('');
      setFile(null);
      const [i, p, j] = await Promise.all([
        api<Item[]>(base + '/items'),
        api<NamedRecord[]>(base + '/payees'),
        api<NamedRecord[]>(base + '/projects'),
      ]);
      setItems(i);
      setPayees(p);
      setProjects(j);
    } catch (e) {
      setConfirmOpen(false);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function namedValue(v: NamedChoice) {
    return v.mode === 'existing' ? v.id : v.mode;
  }
  function namedChoice(v: string): NamedChoice {
    return v === 'blank'
      ? { mode: 'blank' }
      : v === 'create'
        ? { mode: 'create' }
        : { mode: 'existing', id: v };
  }
  return (
    <Stack>
      <Title order={2}>Life2023 CSV 匯入</Title>
      <ol className="import-steps" aria-label="匯入步驟">
        {['上傳', '預覽', '對應', '確認'].map((label, i) => (
          <li
            key={label}
            aria-current={
              i ===
              (confirmed ? 3 : preview ? (reviewed === signature ? 2 : 1) : 0)
                ? 'step'
                : undefined
            }
          >
            {i + 1} {label}
          </li>
        ))}
      </ol>
      {loading && <LoadingState label="載入匯入對應" />}
      {busy && <LoadingState label="處理匯入" hasData />}
      <Text size="sm">
        固定 8
        欄；只支援本位幣交易。上傳與預覽不寫入資料，確認後整批提交；任一筆寫入失敗會整批回滾。檔案最多
        4 MiB、10,000 列。
      </Text>
      <Alert color="blue">
        Life2023 CSV 匯出的文字若以 = + - @ 開頭會加上
        '，重新匯入時會保留。往返前請先建立相同科目樹、類型、幣別與旗標；受防護的科目名稱需要明確對應。
      </Alert>
      {error && (
        <ErrorState
          message={error}
          retry={() => {
            if (raw) void refresh();
            else void upload();
          }}
        />
      )}
      {message && (
        <Alert role="status" color="green">
          {message}
        </Alert>
      )}
      <FileInput
        label="Life2023 CSV 檔案"
        accept=".csv,text/csv"
        value={file}
        disabled={busy}
        onChange={(f) => {
          setFile(f);
          setPreview(null);
          setRaw('');
          setReviewed('');
          setMessage('');
        }}
      />
      <Select
        label="CSV 編碼"
        value={encoding}
        disabled={busy}
        onChange={(v) => {
          if (v) {
            setEncoding(v as typeof encoding);
            setReviewed('');
          }
        }}
        data={[
          { value: 'auto', label: '自動偵測 UTF-8／Big5' },
          { value: 'utf-8', label: 'UTF-8' },
          { value: 'big5', label: 'Big5（CP950）' },
        ]}
      />
      <Button disabled={!file || busy} onClick={() => void upload()}>
        上傳並預覽 CSV
      </Button>
      {preview && (
        <>
          <Text>
            偵測編碼：{preview.encoding}；可匯入 {preview.importable_count}{' '}
            筆；錯誤 {preview.error_count} 筆；疑似重複{' '}
            {preview.suspected_duplicate_count} 筆
          </Text>
          <Text>
            金額合計：{formatMoney(preview.total_amount, ledger.base_currency)}
          </Text>
          <Text>
            待新增：科目 {preview.pending_creates.items}、收付人{' '}
            {preview.pending_creates.payees}、專案{' '}
            {preview.pending_creates.projects}
          </Text>
          {preview.already_imported && (
            <Alert color="red">這個檔案已匯入過，不能再次確認寫入。</Alert>
          )}
          <Title order={3}>名稱對應</Title>
          {preview.item_groups.map((g) => {
            const choice = itemMappings[g.key] ?? g.selection;
            return (
              <Paper withBorder p="sm" key={g.key}>
                <Stack gap="xs">
                  <Select
                    label={`${g.field === 'source' ? '來源項目' : '目的帳目'}：${g.name}`}
                    placeholder="請選擇既有科目或指定新增類型"
                    searchable
                    value={
                      choice?.mode === 'existing'
                        ? choice.id
                        : choice?.mode === 'create'
                          ? 'create:' + choice.data.kind
                          : null
                    }
                    disabled={busy}
                    data={[
                      ...items.map((i) => ({
                        value: i.id,
                        label: `${i.name}（${kinds.find(([k]) => k === i.kind)?.[1]}／${i.currency}）`,
                      })),
                      ...kinds.map(([kind, label]) => ({
                        value: 'create:' + kind,
                        label: '新增為' + label + '科目',
                      })),
                    ]}
                    onChange={(v) => {
                      if (v) {
                        const kind = v.slice(7) as Item['kind'];
                        setItemMappings({
                          ...itemMappings,
                          [g.key]: v.startsWith('create:')
                            ? {
                                mode: 'create',
                                data: {
                                  name: g.name,
                                  kind,
                                  parent_id: null,
                                  non_operating: false,
                                  fixed: false,
                                  credit_card: false,
                                  loan: false,
                                },
                              }
                            : { mode: 'existing', id: v },
                        });
                        setConfirmed(false);
                      }
                    }}
                  />
                  {choice?.mode === 'create' && (
                    <>
                      <Checkbox
                        label={`${g.name} 為業外科目`}
                        checked={choice.data.non_operating}
                        disabled={busy}
                        onChange={(e) =>
                          setItemMappings({
                            ...itemMappings,
                            [g.key]: {
                              ...choice,
                              data: {
                                ...choice.data,
                                non_operating: e.currentTarget.checked,
                              },
                            },
                          })
                        }
                      />
                      <Checkbox
                        label={`${g.name} 為固定性科目`}
                        checked={choice.data.fixed}
                        disabled={busy}
                        onChange={(e) =>
                          setItemMappings({
                            ...itemMappings,
                            [g.key]: {
                              ...choice,
                              data: {
                                ...choice.data,
                                fixed: e.currentTarget.checked,
                              },
                            },
                          })
                        }
                      />
                    </>
                  )}
                </Stack>
              </Paper>
            );
          })}
          {(['payees', 'projects'] as const).map((table) => {
            const groups =
                table === 'payees'
                  ? preview.payee_groups
                  : preview.project_groups,
              mappings = table === 'payees' ? payeeMappings : projectMappings,
              setMappings =
                table === 'payees' ? setPayeeMappings : setProjectMappings,
              records = table === 'payees' ? payees : projects,
              label = table === 'payees' ? '收付人' : '專案';
            return groups.map((g) => (
              <Select
                key={table + g.key}
                label={`${label}對應：${g.name}`}
                disabled={busy}
                searchable
                value={namedValue(mappings[g.key] ?? g.selection)}
                data={[
                  { value: 'create', label: '新增 ' + g.name },
                  { value: 'blank', label: '留空' },
                  ...records.map((r) => ({ value: r.id, label: r.name })),
                ]}
                onChange={(v) => {
                  if (v) {
                    setMappings({ ...mappings, [g.key]: namedChoice(v) });
                    setConfirmed(false);
                  }
                }}
              />
            ));
          })}
          <Checkbox
            label="只匯入無錯誤的列"
            disabled={busy}
            checked={skip}
            onChange={(e) => {
              setSkip(e.currentTarget.checked);
              setConfirmed(false);
            }}
          />
          <Button disabled={busy} onClick={() => void refresh()}>
            重新檢查對應與預覽
          </Button>
          {reviewed !== signature && (
            <Text role="status">條件已變更，請重新檢查預覽後再確認。</Text>
          )}
          <Title order={3}>資料預覽</Title>
          <Text>
            預覽第 {previewPage + 1}／{Math.ceil(preview.rows.length / 100)}{' '}
            頁（每頁最多 100 列）
          </Text>
          <Button
            disabled={previewPage === 0}
            onClick={() => setPreviewPage((p) => p - 1)}
          >
            上一頁預覽
          </Button>
          <Button
            disabled={(previewPage + 1) * 100 >= preview.rows.length}
            onClick={() => setPreviewPage((p) => p + 1)}
          >
            下一頁預覽
          </Button>
          {preview.rows
            .slice(previewPage * 100, (previewPage + 1) * 100)
            .map((r) => (
              <Paper key={r.line} withBorder p="sm" data-testid="import-row">
                <Text fw={600}>
                  第 {r.line} 列{r.suspected_duplicate ? '・疑似重複' : ''}
                </Text>
                <Text>
                  {r.occurred_on ?? r.cells[0]}・
                  {r.amount
                    ? formatMoney(r.amount, ledger.base_currency)
                    : r.cells[3]}
                </Text>
                <Text style={{ overflowWrap: 'anywhere' }}>
                  {r.cells[1]} → {r.cells[2]}
                </Text>
                <Text
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {r.cells[4]}
                </Text>
                {r.errors.map((e, i) => (
                  <Text c="red" key={i}>
                    {e.field}：{issues[e.code] ?? e.code}
                  </Text>
                ))}
              </Paper>
            ))}
          <Checkbox
            label="我已核對預覽與疑似重複列，確認寫入此帳本"
            checked={confirmed}
            disabled={busy || reviewed !== signature}
            onChange={(e) => setConfirmed(e.currentTarget.checked)}
          />
          <Button
            disabled={
              busy ||
              !confirmed ||
              reviewed !== signature ||
              preview.importable_count === 0 ||
              preview.already_imported ||
              (!skip && preview.error_count > 0)
            }
            onClick={() => setConfirmOpen(true)}
          >
            確認寫入 CSV
          </Button>
          <Button
            variant="subtle"
            disabled={busy}
            onClick={() => {
              setPreview(null);
              setRaw('');
              setFile(null);
              setReviewed('');
            }}
          >
            取消匯入
          </Button>
        </>
      )}
      <ConfirmDialog
        opened={confirmOpen}
        title="確認匯入"
        confirmLabel="確認整批寫入"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void commit()}
        busy={busy}
      >
        將寫入 {preview?.importable_count ?? 0}{' '}
        筆交易；請確認預覽、名稱對應與疑似重複列。
      </ConfirmDialog>
    </Stack>
  );
}
