# P2-6 資金預估

依 Workspace ADR-0011 rev.1.4 §2.3.1（8144626），不包含 P2-7 草稿。

## REST 與 MCP

`GET /api/ledgers/:ledger/reports/cash-forecast`；MCP `get_report` 的 `report="cash-forecast"` 呼叫相同 core service。

- `accounts`：REST 逗號分隔 UUID；MCP 也接受 UUID 陣列。省略時選所有本位幣、未封存、非貸款的 asset 科目。外幣排除，跨帳本或他人帳戶回 404。
- `horizon_days`：30（預設）／60／90／180／366，含今天。
- `threshold`：十進位字串，預設 `"0"`。未知參數拒絕。
- `as_of` 使用 Asia/Taipei 今日，不開放任意日期參數；`date_to` 是今日＋N−1。
- `accounts` 回傳起始餘額；`days` 含每日日終合計與各帳戶餘額；`events` 含 `date/source_type/source_id/memo/account_id/amount`；`first_below_threshold` 只在合計嚴格低於門檻時回日期。

## 演算法與唯讀保證

起點是截至今日的已記帳帳面值，未來交易從明天起計入。pending／failed occurrence 使用修改後日期與 template，過期歸到今天；所有狀態的 `(source_rule_id, occurs_on)` 都會擋掉相同期別投影。作用中規則從 `next_on` 使用既有 `nextOccurrence`，遵守 `end_on`。

信用卡重用現有最近 12 期帳單，按繳款日遞增，流出累積未繳扣掉已預估金額；未結帳消費在下一張未結帳帳單的繳款日流出。貸款重用既有攤還表，只列今日起的非零付款。卡片／貸款與週期繳款規則不自動合併，UI 明確提示可能重複。

所有金額累加使用 decimal 字串與 BigInt；只有 ECharts 的無因次共同尺度座標轉為 Number，提示仍使用精確字串。forecast 在 PostgreSQL `REPEATABLE READ READ ONLY` snapshot 內讀取資料，不產生 occurrence、不建立交易、不更新排程。帳單與攤還計算抽為可共用的讀取函式；mutation 的帳本鎖定保持原預設。

零寫入測試比對所有 public 表的列數與完整 row JSON hash。HTTP session 的既有認證活動更新、MCP 的 rate-limit／`mcp.call` audit 維持原規則，與預估 core 的零寫入保證分開驗證。MCP 的事件說明採 `memo`，沿用預設文字遮罩；audit 不含參數或輸出。

## UI 與驗證

`/reports/flow?view=cash-forecast` 第三子檢視，條件依 allowlist 寫入 URL／重新載入還原；圖表有合計與各帳戶曲線、token 主題與事件清單。警告使用 `--warn`。無帳戶、無事件、載入與錯誤沿用全站狀態元件。

- `pnpm check`、`pnpm test:db`（專用合成 DB）
- `pnpm test:ux-cash-forecast`：1440×900、1280×800、390×844、360×780，深淺主題；資料／還原／單帳戶／錯誤／空狀態截圖，axe color-contrast 與溢出檢查。
- `apps/server/src/cash-forecast.db.test.ts`：§6 演算法邊界與全表零寫入。
- `apps/server/src/mcp.db.test.ts`：官方 MCP SDK、REST 一致性、事件遮罩與 scope。

僅使用合成資料，不部署 DS918+、不建立 tag；完成後由 Claude 驗收。
