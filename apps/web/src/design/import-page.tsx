// SPDX-License-Identifier: AGPL-3.0-only
import type { Ledger } from '@finmichi/core/catalog-schemas';
import { Life2023Import } from '../life2023-import';
import { useEffect, useState } from 'react';
import { Button } from '@mantine/core';
import { api, errorMessage } from '../api';
import { EmptyState, ErrorState, LoadingState } from './feedback';
interface Row {
  id: string;
  action: string;
  created_at: string;
  outcome: string;
}
export function ImportPage({ ledger }: { ledger: Ledger }) {
  const [rows, setRows] = useState<Row[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true);
  async function load(more = false) {
    setBusy(true);
    setError('');
    try {
      const q = new URLSearchParams({ action: 'emoney.import', limit: '25' });
      if (more && cursor) q.set('cursor', cursor);
      const page = await api<{ items: Row[]; next_cursor: string | null }>(
        '/api/audit-logs?' + q,
      );
      setRows((old) => (more ? [...old, ...page.items] : page.items));
      setCursor(page.next_cursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <Life2023Import ledger={ledger} />
      <section className="panel emoney-info">
        <h2>E-Money 匯入</h2>
        <p>
          MDB 匯出與匯入使用本機 CLI；網頁不接收 MDB。只會建立新帳本，先
          dry-run，再依報告確認。請自行保管 mapping
          與核對基準，勿上傳真實帳務資料到 repository。
        </p>
        <code>
          pnpm --filter @finmichi/emoney-import cli -- analyze &lt;匯出目錄&gt;
        </code>
        <p>
          完整操作與 analyze／transform／import／reconcile 參數見專案
          tools/emoney-import/README.md。
        </p>
        <h3>自己的 E-Money 匯入操作紀錄（所有帳本）</h3>
        <p>沿用唯讀稽核紀錄，顯示操作結果；不代表每份來源檔的核對報告。</p>
        {error && <ErrorState message={error} retry={() => void load()} />}{' '}
        {busy && (
          <LoadingState label="載入匯入紀錄" hasData={rows.length > 0} />
        )}{' '}
        {!busy && !rows.length && (
          <EmptyState title="尚無 E-Money 匯入紀錄">
            完成 CLI 匯入後可在這裡檢視操作時間與結果。
          </EmptyState>
        )}
        <ul>
          {rows.map((r) => (
            <li key={r.id}>
              {new Date(r.created_at).toLocaleString('zh-TW')} ·{' '}
              {r.outcome === 'success'
                ? '成功'
                : r.outcome === 'denied'
                  ? '拒絕'
                  : '失敗'}
            </li>
          ))}
        </ul>
        {cursor && (
          <Button disabled={busy} onClick={() => void load(true)}>
            載入更多匯入紀錄
          </Button>
        )}
      </section>
    </>
  );
}
