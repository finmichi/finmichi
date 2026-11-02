# P3-3 股利（ADR-0012 rev.1.7）

僅 TWD 帳本；只保存使用者輸入與來源文件識別（檔名、SHA-256、頁碼），不接收檔案內容。所得代碼自由編輯，不內建稅務判斷。**代碼與名稱以集保結算所／發行機構通知為準**；taxable 由使用者依通知明確設定。

投資頁「股利」提供期間報表、依代碼彙總、代碼與預設收入科目管理、新增／修改／刪除股利。「建立預設代碼與科目」是明確的寫入動作：建立業外股利收入、稅費、投資費用及 54C 範例；讀取報表不自動建立資料。未知自由代碼沿用表單選定的預設收入科目，已入帳組成保存當時科目參照；之後編輯代碼不會改寫歷史交易。

- 參與股數預填：重算後 `trade_date < ex_date` 的持股，可手動修改。每股配息與股數可試算應發；實際應發與組成以使用者依通知輸入為準。
- `pay_date` 必填，`ex_date <= pay_date`。現金交易與同次配股都在發放日入帳；除權息日到發放日前的賣出不含尚未取得的配股。
- 金額、匯率、每股金額與股數均使用字串；金額以 BigInt 分計算，分錄呼叫原有交易 preview／calculateBaseAmounts。
- 組成合計等於應發，實發等於應發減扣繳、補充保費與匯費；不符為 `dividend_amount_mismatch`。純配股無 components、transaction_id=null；全零且無配股為 `dividend_empty`。全額扣繳允許，所有零值分錄省略。
- 交割＋實發、收入組成−應發、稅費＋扣項、投資費用＋匯費。同科目合併、每筆交易零和。
- 儲存前預覽與 hash；股利、現金交易、配股及後續成本重算在同一個 DB transaction。影響後續賣出時先顯示成本／損益變化並要求確認；關帳與不足股數沿用股票規則，任何錯誤整批回滾。
- 一般交易不能修改／刪除股利管理交易（`dividend_managed_transaction`）；股票模式不能單獨修改／刪除關聯配股（`dividend_managed_trade`），請由股利頁操作。

REST 前綴 `/api/ledgers/:ledger`，沿用 cookie、Origin、owner 隔離：

- `GET/POST /dividends`、`GET/PUT/DELETE /dividends/:id`。寫入附 `preview_hash`，必要時 `confirm_recalculation=true`。
- `POST /dividend-preview`：`operation` create/update/delete、修改／刪除附 `id`，新增／修改附 `dividend`。
- `GET /securities/:id/dividend-shares?ex_date=...`。
- `GET/POST /income-codes`、`PUT/DELETE /income-codes/:id`、`POST /income-codes/initialize`。
- `GET /reports/dividends?date_from=...&date_to=...&security_id=...`；依發放日篩選。

MCP `get_report` 新增 `dividends`，共用 core service、PAT scope／帳本範圍／遮罩與 audit；note、來源檔名受遮罩保護。沒有股利寫入 tool。共用 `dividendSchema`／`validateDividend` 可供未來 draft_dividend 使用。

備份格式 v5：full 含所得代碼、股利及組成，改寫所有 UUID／收入與扣項科目／現金與配股參照，保持歷史分錄與股票快照、不重算；structure 僅帶所得代碼，股票設定沿用 v4 規則。v1–v4 仍可還原，先驗原 payload checksum，再補空的新表。所有 constraint／trigger 保持啟用。

投資頁預設隱藏 0 股部位，可切換顯示已出清。頁首總計含總市值、成本、未實現損益與報酬率、行情日期；桌面可排序表格第一欄 sticky，手機卡片。皆沿用字串格式化與 design tokens。

本批另修正 main CI 揭露的原查詢捲動競態：載入列移除前執行的 RAF 還原會被 browser scroll anchoring 再移動 13px，改由 DOM commit 後的 layout effect 還原。原 ux-entry-smoke 斷言／timeout 不變；新增 `test:ux-entry-scroll` 以 25ms 排程延遲、CPU 1／4／8 各三次精確驗證。

合成驗證：`pnpm check`、`pnpm test:db`、`pnpm test:ux-dividends`、`pnpm test:ux-entry-scroll` 與既有全部 smoke。新頁矩陣涵蓋四尺寸、雙主題；不得連線真實財務資料或上傳真實通知。

完整 CI 另揭露既有 AI 草稿預填競態：catalog 較晚完成時，會覆寫欄位已輸入的內容。現在僅草稿在 catalog／initial hydration 完成前停用欄位；一般記帳初始焦點不變。MCP 草稿 smoke 加入受控延遲的載入保護檢查，原取消核准保留修改、真正核准入帳的斷言不變。
