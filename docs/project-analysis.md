<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# 專案分析

`/reports/projects` 顯示指定期間內各專案的收入、支出、淨額、交易筆數及首末交易日期；可顯示已封存專案、展開科目樹，或跳到套用專案篩選的明細頁。沒有交易的專案仍列出，未指定專案的交易不列入此報表。

- 收入與支出依分錄科目的 kind／自然方向加總，包含業外與退款；轉帳計入交易筆數與首末日期，但不計入收支。
- 每日平均支出是查詢期間內的支出，除以第一筆到最後一筆交易的天數（含首尾），以整數商餘數的 HALF_UP 直接算至兩位小數，避免一般 numeric 除法的大額中間捨入。無交易時天數為 0、每日平均為 null，畫面顯示「—」。
- 原幣小計直接加總支出分錄的 amount，本位幣小計使用已存 base_amount，不重新套匯率。金額皆為十進位字串。
- 科目明細保留自身與子樹的金額；支出組成長條圖以父科目 rollup 呈現，支援負支出。跨月時顯示有交易月份的收支趨勢與明細，空白月份不新增事件。
- 日期、顯示封存及目前分析的專案可由 URL 還原。`project` 只控制畫面選擇，不送到 API；未知 URL 參數不送 API。

## API 與隔離

`GET /api/ledgers/:ledger/reports/projects?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&include_archived=false`

日期必填，`include_archived` 接受 `true`／`false`，預設 false。回應的 `projects` 含空專案、科目樹、支出幣別小計及月收支。資料只限帳本 owner；跨使用者回 404，SQL function 自身也檢查 owner。

原有 `income-summary`／`category-statistics`（含 CSV）可加 `project_id`。參照必須屬於同帳本，包含查詢封存專案歷史；不存在或跨帳本的參照回 404；格式無效回 400。

查詢頁的 `transactions/summary?group_by=project` 沿用查詢的全部 AND 篩選與 ADR-0004 交易金額口徑：正分錄 base 合計，**不等於專案分析的支出**。專案分組不列未指定專案；回應的全體 `totals` 仍是原查詢條件的交易總計。空專案沒有交易，不產生查詢彙總列。

## Migration 與升級

`0029_project_reports.sql` 只新增 `report_project_entry_facts` view，以及 `report_projects`、`report_income_summary_project`、`report_category_statistics_project` 及精確日均 helper `report_money_average` functions。不改既有表、資料、舊 migration 或舊 function 簽章；未篩專案的既有報表仍呼叫舊 functions。建立於 PostgreSQL 的單一 migration transaction，失敗會整批回滾。

既有備份 schemaVersion 9 不變；v0.2.1 合成帳本可直接升級並還原。部署舊版應用時新增唯讀物件可以保留；不要回改 migration 或刪除 checksum。日後若需移除物件，另以向前 migration 處理。

## 驗證

- `pnpm check`、`pnpm test:db`。
- `TEST_DATABASE_URL=<local synthetic DB> node scripts/project-report-ui-smoke.mjs`：1440／390、淺深主題的篩選、科目展開、連結、封存開關、對比與溢出。
- `test:ux-reports` 同時執行既有報表回歸與專案分析測試。圖表數值先以 BigInt 正規化；Number 僅用於無單位座標。
