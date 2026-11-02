# P3-4 定存（ADR-0012 rev.1.10）

定存設定、付息與到期處理位於 `/investments?tab=deposits`，投資頁分頁可深連結（舊 `view` 連結仍可讀）。建立設定不會入帳；「建立轉存交易」開啟既有記帳抽屜，由使用者確認。

## 計算與入帳

`depositSchedule` 使用 BigInt 整數分與六位年利率。monthly 的到期日必須是起存日加整月、月底夾到當月最後一天；daily 一律 actual/365。按月付息採累計 HALF_UP 差額，非逐期獨立捨入；銀行實際應發、扣繳與補充保費由使用者確認。

`POST /api/ledgers/:ledger/deposits/:id/preview` 接受 operation `interest`、`settlement` 或 `revoke`。後續 interest、settle 或 DELETE postings 帶回 `preview_hash`。每次寫入鎖定帳本、重驗設定與關帳、重新試算；金額使用既有 `previewTransaction`／`createTransaction` 與 `calculateBaseAmounts`。

- `none`：本金回撥入帳戶；提前領回為 closed，否則 matured。
- `principal`：本金不動，利息付銀行；新定存本金不變。
- `principal_and_interest`：實發利息留定存；新本金為原本金加實發。
- 外幣：撥入帳戶同幣別，收入與稅費用本位幣；匯率依使用者、帳本當日、臺銀行情 fallback。
- 零額 posting 不產生交易，仍表示該期已處理，仍檢查關帳。DB CHECK 強制 null 交易的雙向條件。領回本金一定有交易。
- 撤銷會一起刪除交易及未使用的續存設定；續存已有 posting 不可撤銷。一般交易 CRUD 不可改定存管理交易。

設定 API：GET/POST `deposits`、PUT/DELETE `deposits/:id`。已入帳只可改銀行與備註。各 mutation 僅 audit 動作與結果，不記金額、備註、payload。所有資源以 owner/ledger 隔離。

## 資金預估、報表、備份

forecast `deposit` 事件逐腿篩選帳戶，本位幣限定；已處理期與零利息不再投影。未續存本金從定存流出、銀行流入；兩者同選只增加利息。auto_renew 只付利息。預估在 PostgreSQL read-only transaction 執行，不產生 posting。

MCP `get_report: deposits` 重用清單 service，既有 PAT scopes、帳本範圍、文字遮罩與 mcp.call audit 不變。`upcoming(actor, ledger, days)` 提供 active 定存到期查詢；提醒中心留待 P3-5。

備份 schemaVersion 6：full 保留兩表與 nullable 交易關聯、renewal鏈；structure 只保留設定與原 status。所有 ID 重產生，同步改寫 transaction source_id；備份 v1–v5 仍可還原。不停用 constraints，不重算還原交易。

## 自動化對照

- `deposit.test.ts`：monthly/daily 獨立商餘數 oracle、月底／閏年、累計尾差、500 組 property cases。
- `deposits.db.test.ts`：三種 renew、並行防重、零額／全扣繳、關帳、提前解約、撤銷、managed CRUD、錯誤碼、匯率fallback、跨使用者、整批回滾、預估逐腿／零寫入、v6 full/structure、官方 MCP client。
- `audit.db.test.ts`：六個新動作都實際寫入，全文敏感欄位掃描。
- `restores.test.ts`：v1–v5 原 checksum 驗證後擴充空表，輸入不被修改。
- `ux-deposits-smoke.mjs`：1440×900、1280×800、390×844、360×780 × 淺／深色，設定、付息／續存／外幣／零額預覽、dirty guard、空狀態、深連結；axe與水平溢出檢查。

只用合成資料；不含真實存單／帳務。實際銀行利息、扣繳與稅務分類仍由使用者輸入，P3 不自動推定。
