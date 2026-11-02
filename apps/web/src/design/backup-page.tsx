// SPDX-License-Identifier: AGPL-3.0-only
import type { Ledger } from '@finmichi/core/catalog-schemas';
import { BackupRestore } from '../backup-restore';
import { navigate } from './location';
export function BackupPage(props: {
  ledger: Ledger;
  onLedgerChange: (id?: string) => Promise<void>;
}) {
  return (
    <>
      <section className="panel">
        <h2>CSV 匯出</h2>
        <p>
          明細與分錄可依查詢條件匯出；Life2023
          格式入口在明細頁。三張報表各自提供相同篩選的 CSV。
        </p>
        <a
          href="/transactions"
          onClick={(e) => {
            e.preventDefault();
            navigate('/transactions');
          }}
        >
          前往明細匯出
        </a>{' '}
        ·{' '}
        <a
          href="/reports/balance-sheet"
          onClick={(e) => {
            e.preventDefault();
            navigate('/reports/balance-sheet');
          }}
        >
          前往報表匯出
        </a>
      </section>
      <p>待確認的 AI 草稿不納入備份，已核准的交易照常備份。</p>
      <BackupRestore {...props} />
    </>
  );
}
