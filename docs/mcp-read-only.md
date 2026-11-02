# P1.5 MCP 唯讀（ADR-0009）

## 連線

在已登入的 UI 建立 PAT，於 MCP client 的安全認證設定提供 `Authorization: Bearer <PAT>`，URL 為 `<PUBLIC_URL>/mcp`。請勿將完整權杖寫入 repository、shell history 或 log。只有 read scope；沒有寫入、刪除、草稿工具。

官方 `@modelcontextprotocol/sdk` 固定 1.32.1。依 [官方 stateless HTTP 範例](https://ts.sdk.modelcontextprotocol.io/server) 每個 POST 建立獨立 Server／transport，採 JSON response、無 session ID、無 SSE 長連線。GET／DELETE 經認證後回 405；Cookie 不參與 MCP 認證。未提供 Origin 允許；有提供時須精確等於 PUBLIC_URL origin。PAT 管理仍沿用 session 與同源 Origin，不接受 PAT 作管理登入。

每個 token 以 DB 原子更新限制 60 requests／60 秒（從第一個請求起算），包括初始化與協定請求。第 61 次 429，Retry-After: 60；所有 app instance 共用計數，重啟不重設。body 上限 1 MiB；工具結果包含 JSON escaping 與 content wrapper 的序列化 UTF-8 不得超過 1 MiB，超過回 output_too_large 並提示縮小範圍或分頁，不截斷資料。Cache-Control: no-store。

## 工具與共用服務

- list_ledgers：既有 ledgerService.list，套用 PAT 帳本清單。
- list_items：ledgerService.get 與 itemService.list；include_archived 為 boolean。
- search_transactions：queryService.search；沿用 ADR-0004 篩選、cursor 與驗證，limit 為 1–100 整數。
- get_balance：reportService.balance 的 totals，指定 item_id 時加上該資產／負債／權益科目的 rollup item；不存在／不在資產負債表則 not_found。
- get_report：reportService.balance／income／category；report 使用 balance-sheet、income-summary、category-statistics。參數與 REST 相同，沿用 1000 期間限制。

工具沒有額外的查詢 SQL。權限與報表／金額口徑來自既有 core；輸出金額、匯率維持字串。查詢時再次驗證 owner 和 token 帳本範圍，不允許的帳本與他人帳本都回 not_found。預設遞迴遮罩 memo、invoice_no、payee_name、project_name 的文字為 [masked]；空關係仍為 null；科目名稱與金額不遮罩。

Resources：finmichi://ledgers/{id}/items（同 owner／範圍驗證，含封存科目）；finmichi://docs/report-fields（靜態報表欄位說明）。資源同樣受 Bearer、Origin、rate limit 與大小限制。

## Audit 與驗證

pat.create／pat.revoke／mcp.call 同步加入 DB action CHECK 與 UI 篩選。每次工具呼叫恰好一筆 audit，只存 actor、動作、結果、列舉 tool 與前綴，不存參數、輸出或完整憑證。未知工具名回 invalid_input，記 tool=null，避免將任意輸入塞入 audit。DB 無法寫 audit 時整個呼叫失敗，不回傳帳務結果。

`pnpm check`、`pnpm test:db`、`pnpm audit:prod`。整合測試以官方 Client／StreamableHTTPClientTransport 在 localhost 呼叫全部五工具與 resources，對照 REST，驗證遮罩、範圍／owner、撤銷／到期、Cookie-only、Origin、每次 audit、輸入／輸出 1 MiB、分頁恢復、第 61 次與並行計數。PAT 管理 `pnpm test:pat-ui` 在 390px 驗證，截圖前隱藏並撤銷憑證。

只使用合成資料；Claude Code 真實連線與人工驗收留給 Claude，尚未宣稱通過。無 NAS 部署、無 release tag、無 MCP 寫入功能。
