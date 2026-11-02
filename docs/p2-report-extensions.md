# P2-4：損益表與流量報表

依 ADR-0011 rev.1（Workspace `fd9f086`），只使用歷史帳面值；所有金額、匯率與百分比都是 decimal 字串。REST、CSV 與 MCP 共用 `reportService`；SQL 位於新的 `0020_report_extensions.sql`，不修改已合併 migrations。

## 介面

`GET /api/ledgers/:ledger/reports/` 下新增：

| 報表             | 參數                                                                  | 頁面                                |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------- |
| `profit-loss`    | `date_from`、`date_to`、`grain=month/quarter/year`，最多 10 年        | `/reports/profit-loss`              |
| `net-worth-flow` | 起訖日、`grain=day/month/quarter/year`，最多 1,000 時段               | `/reports/flow?view=net-worth-flow` |
| `account-ledger` | 起訖日、資產／負債 `item_id`、`limit`（預設 100、最大 500）、`cursor` | `/reports/flow?view=account-ledger` |

MCP `get_report.report` 同名新增三種值，沿用既有 PAT 帳本範圍、文字遮罩、1 MiB 輸出上限與每次一筆 `mcp.call`；不新增寫入工具。跨使用者或不屬於帳本的科目回 404。

損益表不接受 `fixed`（包含 `all`），REST 與 MCP 均回 `invalid_input`；UI 的 URL allowlist 不會把它或未知參數送到 API。營業支出固定列出「其中固定性」「其中變動」，相加等於營業支出；損益表各期與合計無條件等於同期間報表①。旗標看分錄科目自身，祖先只作 rollup；有非零科目時保留全部祖先，即使子項互相抵銷。

帳戶異動的原幣與本位幣均採自然方向，分幣別獨立累計（負債反轉符號）。排序為日期、交易建立時間、交易 UUID、分錄位置、分錄 UUID，後兩個 UUID 是同時建立時的穩定 tie-break。`carry` 是目前頁末各幣別累計，不由客戶端提供；後續頁先計算完整歷史 window，再套 cursor，因此不會從零重算。cursor 綁定 owner、帳本、科目、日期區間；變更篩選後必須重新查詢。

每個端點另有 `.csv`，UTF-8 BOM；系統數值保留負號與數值型態，使用者文字依既有 formula injection 規則防護。帳戶 CSV 用單一唯讀 repeatable-read transaction 走完全部 cursor 頁，匯出完整篩選結果。瀏覽器的跨頁查詢不保留伺服器 snapshot；若期間有交易被修改，應重新查詢以取得一致的新結果。

## UI 與驗證

損益表桌面多期並列、第一欄 sticky、EdgeScroll；手機選時段或合計後顯示單欄科目卡片。淨值流量提供期末折線與收支長條，恆等式不符顯示警示與差額。帳戶分錄可開既有記帳抽屜修改，保留 dirty guard。資金預估屬 P2-6，本 PR 不提供該子檢視。

`pnpm test:ux-report-extensions` 使用合成資料執行四尺寸、兩主題、資料／骨架／空資料／錯誤／重試／編輯、URL allowlist、載入更多與 CSV；截圖及 `matrix.json` 納入 CI artifact。`report-extensions.db.test.ts` 比對報表①／④、固定性小計、零收入利益率、退款與虧損、equity 調整與轉帳、多幣別、跨頁與非法 cursor；官方 MCP SDK client 驗證與 REST 一致及遮罩／audit。
