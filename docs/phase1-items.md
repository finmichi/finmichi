# Phase 1.2：科目樹

依賴帳本 CRUD PR；本 PR 僅新增科目樹 API + UI，不變更已合併 migration。

`/api/ledgers/:ledger/items` 支援 GET（預設排除封存）、POST；`/:item` 支援 GET、PATCH。管理列表加 `?include_archived=true`。strict zod schemas 位於 core 的純 schema export，權限及 mutation audit 在 core service。

新增欄位：name、kind（asset/liability/income/expense/equity）、currency、parent_id（預設 null）、non_operating/fixed/credit_card/loan/archived（預設 false）。PATCH 只接受 name、parent_id、旗標及 archived；省略的欄位原值不變，parent_id=null 表示移到根層。建立後類型與幣別固定，避免歷史金額解讀改變。

上層科目必須在同帳本；self/descendant cycle 由既有 DB trigger 在 ledger lock 下阻擋，對向並行搬移仍安全。父子 kind 必須一致（service 與 migration 0005 trigger 強制）；父子 currency 可不同，無隱含幣別轉換。

UI 提供樹狀顯示、上層選單、改名、搬移、四個旗標及封存／取消封存。封存只影響被選科目，不刪除其歷史與子科目；未提供硬刪除。讀取歷史可依 ID 取得已封存科目。

初版驗證（後續 kind 修正另見 phase1-item-kind-invariant.md）：`pnpm check` exit 0，36 unit tests；真實 PostgreSQL `pnpm test:db` 62 tests 通過（新增8）。涵蓋 defaults、PATCH 保留、循環／並行搬移、strict fields、權限、Origin、名稱唯一及封存歷史。Chrome UI 實際新增父／子、改名、搬移、封存及復原通過；390px 無水平溢出，截圖 `items-ui-390.png`。僅合成資料、本機 TLS fixture，未部署或建立 tag。
