# Phase 1.2：常用摘要 CRUD

依賴專案／收付人／科目樹／帳本 stacked PR；本主題新增 memo_templates 的 API + UI，不新增或修改 migration。

`/api/ledgers/:ledger/memo_templates`：GET、POST；`/:record`：GET、PATCH、DELETE。新增必填 name（trim，1–200 字）、memo（trim，1–2000 字；保留內部換行），archived 預設 false。PATCH 至少一欄，省略保留；未知欄位拒絕。列表預設排除封存，管理用 `include_archived=true`；單筆可讀封存。

core owner/ledger 隔離、strict schemas、session/Origin、audit、case-insensitive per-ledger 名稱唯一均與其他 metadata 一致。UI 提供文字 textarea、新增、改名／改內容、封存／復原、二次確認刪除。React 純文字呈現，不執行 HTML。transaction.memo 是複製文字，不是範本 FK；刪除範本不影響已套用文字。交易表單本身屬 Phase1.3，尚未實作。

驗證：`pnpm check` exit 0，36 unit tests；`pnpm test:db` 84 tests PASS（本主題新增8）。除共用 API/core owner、strict schema、Origin、唯一性、封存與 delete/audit 外，另驗必填／長度、獨立 partial update 保留 memo/archived、合成 HTML/SQL 字串，以及刪除範本後交易 memo 原文不變。

Chrome UI 實際操作五個基本資料主題通過；常用摘要 create/rename/archive/restore/delete 與合成 script 字串未執行的檢查通過。390px 無水平溢出，截圖 `memos-ui-390.png`。僅本機合成資料、self-signed TLS fixture；未部署或建立 tag。等待 Claude 驗收後再續其他 Phase1 項目。
