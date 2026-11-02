# brief 1.9：操作紀錄

## 寫入盤點

| 來源                                           | action                                                                                                | 時機／結果                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/sessions.ts`、OIDC callback | `login`、`logout`                                                                                     | 登入成功、allowlist 拒絕；登出有 session 時成功。無法識別使用者的拒絕／OIDC 錯誤不綁 user_id，不出現在任何個人檢視。 |
| `catalog.ts`                                   | `ledger.create/update/delete/lock/unlock`                                                             | 帳本新增、修改、刪除、關帳與確認解鎖；關帳不記新舊日期。                                                             |
| `items.ts`                                     | `item.create/update`                                                                                  | 科目新增、改名、搬移、封存；目前不提供科目刪除。                                                                     |
| `named-records.ts`                             | `payees.create/update/delete`、`projects.create/update/delete`、`memo_templates.create/update/delete` | 常用資料 CRUD／封存。                                                                                                |
| `transactions.ts`                              | `transaction.create/update/delete`                                                                    | 交易及多分錄整筆操作，一次一筆 audit。                                                                               |
| `life2023.ts`                                  | `life2023.import`                                                                                     | CSV 確認整批寫入／失敗，不記各列內容。                                                                               |
| `tools/emoney-import/src/import.ts`            | `emoney.import`                                                                                       | 已識別 owner 的 apply 成功／寫入失敗；analyze/transform/dry-run 不記寫入紀錄。                                       |
| `restores.ts`                                  | `backup.restore`                                                                                      | full/structure 確認還原整批操作。                                                                                    |
| `backups.ts`                                   | `backup.download`                                                                                     | 新增：備份快照完成後記 success；拒絕／失敗有 denied/error，不記名稱、檔案或 checksum。                               |

`pats.ts` 新增 pat.create／pat.revoke；`mcp.ts` 新增 mcp.call（每次 tools/call 一筆，含驗證／權限／大小錯誤），同步 action CHECK 與 UI 篩選。MCP resource 讀取與協定初始化不是工具呼叫，不產生 mcp.call。

共用 mutation 的已知 actor 格式驗證、DomainError 及未預期錯誤均寫入結果；成功紀錄與 mutation 同一 transaction，失敗會回滾資料後另寫 denied（404）或 error。備份下載現在會新增最小 audit，但不修改帳務內容。預覽、試算、一般 GET、報表／CSV 查詢、audit 查詢均不產生寫入 audit。無 session 的重複登出沒有可歸屬的操作；Origin／未登入／壞 JSON 等在進入 service 前就被擋下，沒有可信的操作 actor。不為此儲存請求內容。CLI 在建立 owner 身分前的無效參數／plan 也不記具名 audit。

DB 只含 id、user_id、action、outcome、created_at、source_ip、subject_hash、tool、token_prefix。MCP 只存列舉工具名與前八字元前綴，不存參數與輸出；未知工具名稱不存入 DB（tool 為 null）。既有 denied login 的 IP／subject hash 保留，不是 token hash。新 migration `0013_audit_owner_cursor.sql` 加 owner cursor index 及 action allowlist CHECK，阻止自由文字塞入 action；不新增 payload 欄。未來新增 action 須同步 core schema／UI label／追加 migration／coverage test；既有 migration 不可修改。

## 唯讀 API

- `GET /api/audit-logs?from=<ISO8601>&to=<ISO8601>&action=<allowlist>&outcome=success|denied|error&limit=25&cursor=...`
- `GET /api/audit-logs/:id`
- 只以 session actor 查詢；其他 user_id、user_id=null 或不存在的紀錄同樣 404。匿名 401。未知 filter／錯誤時間區間／非法 cursor 為 400。
- from/to 含邊界、最多微秒，接受時區 offset；所有條件 AND。排序實際 timestamp DESC、bigint id DESC；id 一律字串，不經 JavaScript Number。cursor 保留完整微秒、id，綁定 actor＋篩選條件；他人 cursor anchor 回 404，自己換篩選回 400。
- Timestamp 經 `::text::timestamptz` 綁參數，避免 driver 以 JS Date 截成毫秒；保留微秒區間及頁面邊界。不得改成直接 timestamptz parameter serializer。
- 回應只有 `id/action/outcome/created_at`，不回 user_id、IP、subject hash、token、cookie、帳務／檔案內容。GET 不修改 audit；正常 session last_seen 更新仍由既有 middleware 執行。

## UI／驗證

登入後「操作紀錄」收合區與帳本獨立，即使沒有帳本也可查詢。時間採本機時區輸入／顯示；變更篩選清除舊 cursor，提供載入更多、空結果、錯誤提示；390px 使用卡片。

`pnpm check`、`pnpm test:db`（全新合成 DB）；`TEST_DATABASE_URL=postgres://synthetic@127.0.0.1:PORT/synthetic CHROME_BIN=/path/to/chrome pnpm test:audit-ui`。UI 測試只允許 localhost synthetic/life_test DB，需既有 dev TLS（setup-dev.sh）與 development mock transport；CI 已納入 Playwright 與 screenshot artifact。

Audit DB 測試透過真實 service/HTTP/CLI apply 產生所有 26 種 action，對 audit 全列做欄位 allowlist、action allowlist 與合成敏感 marker 全文掃描；驗證不含 token/cookie/金額/摘要/檔案內容。另測 404 隔離、無主紀錄、他人 cursor、GET 無 audit 寫入、BigInt/microsecond ties、直接 SQL 對照、惡意自由 action DB 拒絕、未預期錯誤回滾及已知 actor 無效 payload 留 error。

此批完成後等 Claude 驗收；P1.5 MCP 唯讀另見 mcp-read-only.md；不開始 MCP 草稿／寫入、不接觸真實帳務、不部署 NAS、不建立 release tag。

P2-2 新增 `recurring.create`／`recurring.update`／`recurring.delete`／`recurring.generate`／`recurring.post`／`recurring.skip`，同步 DB CHECK、core 白名單與 UI 中文篩選。規則／當期變更皆不記樣板、日期、名稱、金額、摘要；成功入帳沿用 `transaction.create`。詳見 [週期交易](p2-recurring.md)。
