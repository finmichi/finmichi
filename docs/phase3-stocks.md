# P3-2 股票（ADR-0012 rev.1.6）

只支援 TWD 帳本，台股 TWSE／TPEx（含 ETF）。證券科目須為 TWD 資產並勾選「證券」。交割為一般 TWD 資產；投資費用為業外支出；投資損益為業外收入。股利功能見 [P3-3 股利](phase3-dividends.md)。

`/investments` 提供持股、市值、未實現損益及可選日期區間的已實現損益（條件寫入URL）；個股頁可記錄買賣、配股、調整、編輯歷史及管理手動價格。一般記帳抽屜的「股票」模式提供買賣；明細的「股票」標籤交易會開啟股票編輯。

計算使用 BigInt（分）；成交價金先 HALF_UP 至 2 位。依 `(trade_date, sequence)` 重播，賣光移出全部成本。平均成本只顯示 HALF_UP 4 位。回溯異動先預覽後續損益與成本變化，確認後在單一 transaction 重算；交割與費用分錄不變。預覽 hash 在寫入時重新檢查，過期回 `preview_changed`。關帳與任一歷史負持股都整批拒絕。

REST 前綴 `/api/ledgers/:ledger`，沿用 cookie、Origin 與 owner 隔離：

- `GET/POST /securities`；`GET/PATCH/DELETE /securities/:id`。
- `POST /securities/:id/trade-preview`：`operation` create/update/delete，修改／刪除附 `trade_id`。
- `POST /securities/:id/trades`、`PUT/DELETE /securities/:id/trades/:trade`：附 `preview_hash`，回溯時 `confirm_recalculation=true`。
- `GET /securities/:id/trades?limit=25&cursor=...`：歷史 cursor 分頁；`GET /securities/:id/trade/:trade`。
- `GET/POST /manual-prices`、`DELETE /manual-prices/:id`。
- `GET /reports/holdings?as_of=YYYY-MM-DD`；`GET /reports/realized-gains?date_from=...&date_to=...&security_id=...`。

MCP `get_report` 新增 `holdings`、`realized-gains`，重用同一 core service，遮罩／PAT 帳本範圍／audit 不變。MCP 沒有股票寫入工具。

價格依基準日取值，手動價格優先於市場價格；無行情沿用帳面成本並標示。資產負債表市值只供檢視，不入帳，使用 P3-1 純估值函式與交易日過期提示。

JSON 備份（目前 v5，相容 v4）：full 包含證券、股票交易與手動價格；structure 只帶證券設定，不帶交易或手動價格。還原改寫所有 UUID／科目／交易參照並保留順位、成本快照和原分錄，不重算、不停用 constraints；v1–v3 仍支援，先驗證原始 payload checksum 再補空的新表。

合成驗收：`pnpm check`、`pnpm test:db`、`pnpm test:ux-stocks`。獨立 Decimal oracle 在 `packages/core/test/fixtures/securities/`，CI 直接讀 JSON，不依賴 Python。UI 矩陣涵蓋 1440×900、1280×800、390×844、360×780 與兩種主題；不得使用真實帳務資料。
