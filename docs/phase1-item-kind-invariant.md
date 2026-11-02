# 父子科目 kind 一致性

此 PR 修正 Claude PR11–17 驗收的必修項目。父子科目必須有相同 kind；幣別可不同，例如 TWD 資產群組下的 USD 資產帳戶。不開始 Phase1.3。

## Service 與 UI

core itemService.create／update(parent_id) 在 owner/ledger lock 內檢查父科目，kind 不符回 400 `parent_kind_mismatch`。不同帳本或不存在的 parent 維持404，kind/currency 仍不接受 PATCH。拒絕時所有其他欄位與資料寫入 rollback，audit 不含名稱或摘要。

父科目選單只列同 kind；新增表單變更 kind 時會清除不相容 parent，仍顯示各科目的獨立幣別。API 的錯誤訊息亦有中文說明。

## DB migration 0005

不修改0001–0004。migration先取得 items 表 SHARE ROW EXCLUSIVE lock，檢查既有每一對父子 kind；有違規即失敗、rollback，不默默重分類或搬移資料。表鎖防止 preflight 與 trigger 安裝之間插入違規資料。

`items_kind_consistent` trigger 涵蓋 INSERT 以及 UPDATE OF parent_id/kind/ledger_id。除檢查新父科目，亦檢查既有子科目，防止直接 SQL 改 parent.kind 造成違規。trigger 先取得 ledger row lock，將 concurrent parent kind change 與 child insert/move 序列化。違規使用 SQLSTATE23514、constraint `items_parent_kind`，訊息不含資料內容。

已合併 migration 保持 immutable；若未來要調整規則，以新 migration 處理。此修正不自動改動既有資料；遇 migration preflight 失敗，應停止啟動，由 Claude／使用者決定資料修正方案，不應停用 trigger。kind 在 API 不可改；DB trigger 即時驗證，直接 SQL 多筆更改亦不能短暫違反此規則。

## 合成資料測試

新增4項HTTP/core測試，兩層各自驗 create/move 的不同 kind 拒絕、同 kind 允許，包含不同幣別、整筆 PATCH rollback 與 audit。

新增6項獨立 DB 測試：raw SQL insert/move 拒絕、直接修改 child.kind／parent.kind 拒絕、同 kind 不同幣別允許、concurrent kind change/insert、正式 migration runner 在獨立 schema 的既有違規資料失敗及回滾。以明確的合成資料修正後，可重跑成功且 idempotent；0001–0004使用原始檔案 checksum。

以最終合併 main 為基礎：frozen install/check/audit exit0，40項unit/property tests、94項DB/API tests PASS（新增10項）。CI 與最終結果記於 PR 及 測試驗證紀錄。Chrome390px 實測父選單篩選、切換kind清除parent、USD子科目建立 PASS，無水平溢出，截圖 `kind-parent-ui-390.png`。所有測試只用合成資料；沒有 NAS 操作、release tag 或真實財務檔案。
