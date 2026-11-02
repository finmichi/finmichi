# SPDX 標頭與排除清單

原始碼授權為 AGPL-3.0-only，見根目錄 LICENSE／NOTICE。下列歷史 migration 的全文 checksum 已用於驗證已套用的資料庫版本，逐 byte 保留，不增加標頭、不變更授權或 migration runner。新增 migration 從建立時就必須包含 SPDX 標頭。

- `packages/db/migrations/0001_init.sql`
- `packages/db/migrations/0002_login_audit.sql`
- `packages/db/migrations/0003_ledger.sql`
- `packages/db/migrations/0004_money_invariants.sql`
- `packages/db/migrations/0005_item_parent_kind.sql`
- `packages/db/migrations/0006_entry_position.sql`
- `packages/db/migrations/0007_query_indexes.sql`
- `packages/db/migrations/0008_balance_report.sql`
- `packages/db/migrations/0009_income_report.sql`
- `packages/db/migrations/0010_category_report.sql`
- `packages/db/migrations/0011_income_period_limit.sql`
- `packages/db/migrations/0012_provenance_deleted_targets.sql`
- `packages/db/migrations/0013_audit_owner_cursor.sql`
- `packages/db/migrations/0014_personal_access_tokens.sql`
- `packages/db/migrations/0015_mcp_read_access.sql`
- `packages/db/migrations/0016_ledger_lock_audit.sql`
- `packages/db/migrations/0017_recurring.sql`
- `packages/db/migrations/0018_budgets.sql`
- `packages/db/migrations/0019_worker_backoff.sql`
- `packages/db/migrations/0020_report_extensions.sql`
- `packages/db/migrations/0021_cards_loans.sql`
- `packages/db/migrations/0022_transaction_drafts.sql`
- `packages/db/migrations/0023_market_data.sql`
- `packages/db/migrations/0024_securities.sql`
- `packages/db/migrations/0025_dividends.sql`
- `packages/db/migrations/0026_deposits.sql`
- `packages/db/migrations/0027_foreign_cards_reminders.sql`
- `packages/db/migrations/0028_emoney_investments.sql`

其他範圍：生成的 dist、node_modules 與第三方依賴不提交；CSV／JSON／Python 合成 fixture 以及字型、SVG、PNG 等非指定副檔名不增加程式標頭。字型的 OFL 授權保留於 apps/web/public/font-licenses.txt；其他第三方依賴見 third-party-licenses.md。本次沒有位於指定副檔名範圍內的 fixture／vendor／generated 檔案。
