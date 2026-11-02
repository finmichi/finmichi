# P2-7 MCP-2 草稿

依 ADR-0011 rev.1.5 §4／§6、ADR-0009 的權限及遮罩、ADR-0007 的備份排除規則。

## 權限與入口

PAT 預設仍為 `read`。管理中心建立時必須明確勾選「允許 AI 建立待確認草稿」，畫面提示「AI 可建立待確認草稿，不能直接入帳」。`draft` 包含原五個唯讀工具，另開 `draft_transaction`、`suggest_item`、`list_drafts`；read token 不廣告這三個工具，直接呼叫也回 `insufficient_scope`。`write` 仍不接受。原有到期、撤銷、ledger scope、60 requests/min、1 MiB body/output 全部沿用。

- `draft_transaction`：`ledger_id`＋交易建立格式＋`note`（最多500字），回 id、pending、preview。非冪等，遇傳輸不確定先以 `list_drafts` 檢查，不盲目重送。
- `suggest_item`：`ledger_id`、`text`；在該帳本本人歷史摘要／收付人作 literal、不分大小寫比對，排除封存科目；依出現頻率、最近交易建立時間、id排序，最多5筆科目 metadata，不輸出歷史交易內容。
- `list_drafts`：只看目前token建立且仍在允許範圍的草稿；可帶 `status`、`limit`（1–50，預設25）、`cursor`。日期microseconds＋id穩定排序，cursor綁定owner/token/篩選。遮罩開啟時遞迴遮罩摘要、發票、收付人／專案名稱及新增的note；科目與金額仍可讀。

MCP **沒有**核准、拒絕、刪除或直接建立正式交易的工具。

## 人工審核

`/admin/drafts` 位於「安全與整合」，導覽及總覽顯示pending數。提供待確認／全部、cursor載入更多、完整分錄檢視、核准與拒絕。修改沿用420px記帳抽屜／手機全螢幕；修改後的「確認修改並核准」會再開ConfirmDialog，取消保留編輯內容，直到人工確認才原子入帳，不另外寫入未核准的修改。Esc／遮罩／離頁有dirty guard。

Cookie-only REST（同時套用Origin檢查）：

- `GET /api/ledgers/:ledger/drafts`（status／limit／cursor）及 `/:id`。
- `POST .../:id/approve`，body `{}` 或 `{ "payload": <完整交易建立格式> }`。
- `POST .../:id/reject`，body `{}`。

Bearer-only呼叫上述API為401。所有owner／ledger查核在core；外人存取404。核准先鎖帳本與草稿，再用既有交易preview與createTransaction驗證／建立（無另一套匯率計算）；寫入 `source_system='mcp-draft'`、`source_id=<draft UUID>`，同一transaction內更新草稿payload、preview、狀態與transaction_id。重複／並發核准最多建立一筆，失敗全部回滾。核准時重新檢查關帳、封存與金額，草稿期間的參照失效不會繞過驗證。

## 上限與到期

`MCP_DRAFT_MAX_BASE_AMOUNT` 為非機敏的server設定，透過既有compose env_file傳入：預設 `100000`，允許 `0.01`～`10000000`、最多2位小數；非法值在app啟動即拒絕。以ADR-0004「交易金額」＝preview正分錄base合計判斷；全程字串／BigInt，不經float。建立與修改核准均套用。API清單回傳目前上限供UI顯示。

每帳本最多50筆pending，跨token建立以帳本鎖序列化；拒絕／核准／到期後釋出額度。滿額回 `draft_pending_limit`，超過單筆上限回 `draft_amount_limit`。

Worker於Asia/Taipei 06:00後的既有排程迴圈處理14天到期，含沒有週期規則的帳本。到期更新與每筆 `draft.expire` audit 以單一SQL CTE原子完成；重跑不重複記錄。即使worker尚未處理，超過14天也不能核准。沿用worker退避與hardening。

## 稽核、備份與驗證

每次工具一筆 `mcp.call`（固定tool列舉、token_prefix）；另外記錄 `draft.create`／`draft.approve`／`draft.reject`／`draft.expire`。audit沒有payload、preview、note、金額、摘要、token或cookie內容。

草稿不加入JSON備份schema，full／structure均排除；已核准交易正常備份，`mcp-draft` source_id原樣還原。新增0022 migration，所有舊migration不變。

驗證：`pnpm check`、`TEST_DATABASE_URL=... pnpm test:db`、`pnpm test:ux-mcp-drafts`。全部只用localhost合成DB；UX涵蓋4尺寸×2主題×9狀態72PNG，包含實際修改／取消／核准／拒絕、dirty guard、PAT明確授權、總覽提示、axe及overflow。共用EdgeScroll補上labelled region role，讓完整WCAG掃描的ARIA標記有效。實際測試數與CI結果見Workspace evidence，未執行不宣稱通過。
