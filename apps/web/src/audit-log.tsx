// SPDX-License-Identifier: AGPL-3.0-only
import { EmptyState, ErrorState, LoadingState } from './design/feedback';
import { BackToTop } from './design/back-to-top';
import { auditActions } from '@finmichi/core/audit-schemas';
import { useEffect, useState } from 'react';
import { Button, Select, Stack, Text, TextInput } from '@mantine/core';
import { api, errorMessage } from './api';
const labels: Record<string, string> = {
  'dividend.create': '新增股利',
  'dividend.update': '修改股利',
  'dividend.delete': '刪除股利',
  'income_code.create': '新增所得代碼',
  'income_code.update': '修改所得代碼',
  'income_code.delete': '刪除所得代碼',
  'reminder.settings_update': '更新提醒設定',
  'deposit.create': '新增定存',
  'deposit.update': '修改定存',
  'deposit.delete': '刪除定存',
  'deposit.interest': '定存付息',
  'deposit.settle': '定存結清／續存',
  'deposit.revoke': '撤銷定存入帳',
  'income_code.initialize': '建立股利預設科目與代碼',
  'security.create': '新增證券',
  'security.update': '修改證券',
  'security.delete': '刪除證券',
  'security.price_update': '儲存手動股價',
  'security.price_delete': '刪除手動股價',
  'security.trade_create': '新增股票交易',
  'security.trade_update': '修改股票交易',
  'security.trade_delete': '刪除股票交易',
  'security.recalculate': '重算股票成本與損益',
  'mcp.call': 'MCP 呼叫',
  'market.fx_upload': '上傳臺銀匯率',
  'draft.create': '建立 AI 草稿',
  'draft.approve': '核准 AI 草稿',
  'draft.reject': '拒絕 AI 草稿',
  'draft.expire': 'AI 草稿到期',
  'recurring.create': '新增週期規則',
  'recurring.update': '修改週期規則／當期',
  'recurring.delete': '刪除週期規則',
  'recurring.generate': '產生週期交易',
  'recurring.post': '確認週期入帳',
  'recurring.skip': '略過週期交易',
  'budget.update': '儲存預算',
  'budget.delete': '刪除預算',
  'card.update': '儲存信用卡設定',
  'card.delete': '刪除信用卡設定',
  'loan.update': '儲存貸款設定',
  'loan.delete': '刪除貸款設定',
  'ledger.lock': '設定關帳',
  'ledger.unlock': '解鎖關帳',
  'pat.create': '新增存取權杖',
  'pat.revoke': '撤銷存取權杖',
  login: '登入',
  logout: '登出',
  ledger: '帳本',
  item: '科目',
  payees: '收付人',
  projects: '專案',
  memo_templates: '常用摘要',
  transaction: '交易',
  create: '新增',
  update: '修改／封存',
  delete: '刪除',
  'life2023.import': 'CSV 匯入',
  'emoney.import_investments': 'E-Money 投資轉入／撤銷',
  'emoney.import': 'E-Money 匯入',
  'backup.restore': '還原',
  'backup.download': '備份下載',
};
const label = (s: string) =>
  labels[s] ??
  s
    .split('.')
    .map((k) => labels[k] ?? k)
    .join('：');
const outcomes: Record<string, string> = {
  success: '成功',
  denied: '拒絕',
  error: '失敗',
};
interface Row {
  id: string;
  created_at: string;
  action: string;
  outcome: string;
}
interface Page {
  items: Row[];
  next_cursor: string | null;
}
export function AuditLog() {
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [action, setAction] = useState<string | null>(null),
    [outcome, setOutcome] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [filter, setFilter] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void load();
  }, []);
  function changed() {
    setCursor(null);

    setLoaded(false);
    setError('');
  }
  async function load(more = false) {
    setBusy(true);
    setError('');
    try {
      const q = new URLSearchParams(more ? filter : 'limit=25');
      if (!more) {
        if (from) q.set('from', new Date(from).toISOString());
        if (to) q.set('to', new Date(to).toISOString());
        if (action) q.set('action', action);
        if (outcome) q.set('outcome', outcome);
      }
      if (more && cursor) q.set('cursor', cursor);
      const p = await api<Page>('/api/audit-logs?' + q.toString());
      setRows((old) => (more ? [...old, ...p.items] : p.items));
      setCursor(p.next_cursor);
      setLoaded(true);
      if (!more) setFilter(q.toString());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack>
      <h2>稽核紀錄</h2>
      <Stack>
        <Text size="sm">
          只顯示自己的操作時間、動作與結果，不含帳務內容。時間依本機時區顯示。
        </Text>
        <TextInput
          type="datetime-local"
          label="操作起始時間"
          value={from}
          disabled={busy}
          onChange={(e) => {
            setFrom(e.currentTarget.value);
            changed();
          }}
        />
        <TextInput
          type="datetime-local"
          label="操作結束時間"
          value={to}
          disabled={busy}
          onChange={(e) => {
            setTo(e.currentTarget.value);
            changed();
          }}
        />
        <Select
          label="操作動作"
          clearable
          value={action}
          data={auditActions.map((value) => ({
            value,
            label: label(value),
          }))}
          disabled={busy}
          onChange={(v) => {
            setAction(v);
            changed();
          }}
        />
        <Select
          label="操作結果"
          clearable
          value={outcome}
          data={Object.entries(outcomes).map(([value, label]) => ({
            value,
            label,
          }))}
          disabled={busy}
          onChange={(v) => {
            setOutcome(v);
            changed();
          }}
        />
        <Button loading={busy} onClick={() => void load()}>
          查詢操作紀錄
        </Button>
        {error && <ErrorState message={error} retry={() => void load()} />}
        {!loaded && rows.length > 0 && !busy && (
          <Text role="status">條件已變更，請查詢以套用。</Text>
        )}
        {busy && (
          <LoadingState label="載入操作紀錄" hasData={rows.length > 0} />
        )}
        <div className="panel">
          <table className="audit-table">
            <thead>
              <tr>
                <th>時間</th>
                <th>動作</th>
                <th>結果</th>
                <th>紀錄識別碼</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="時間">
                    {new Date(r.created_at).toLocaleString('zh-TW')}
                  </td>
                  <td data-label="動作">{label(r.action)}</td>
                  <td data-label="結果">
                    <span className={'audit-outcome outcome-' + r.outcome}>
                      {outcomes[r.outcome] ?? r.outcome}
                    </span>
                  </td>
                  <td data-label="紀錄識別碼">{r.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loaded && <Text role="status">已載入 {rows.length} 筆操作紀錄</Text>}
        {loaded && rows.length === 0 && (
          <EmptyState title="沒有符合條件的操作紀錄。">
            試著調整時間、動作或結果。
          </EmptyState>
        )}
        {cursor && (
          <Button disabled={busy} onClick={() => void load(true)}>
            載入更多操作紀錄
          </Button>
        )}
      </Stack>
      <BackToTop />
    </Stack>
  );
}
