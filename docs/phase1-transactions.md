# Phase 1.3：交易 API

所有路徑位於 `/api/ledgers/:ledger`，沿用 DB session、Origin 檢查及帳本 owner 檢查。

- `GET /transactions`：最近 100 筆（日期、建立時間、id 降冪）；完整查詢屬 Phase 1.4。
- `POST /transactions`：建立；`GET /transactions/:id`：含按輸入順序排列的分錄。
- `PATCH /transactions/:id`：修改；省略欄位保留，明確 null 清除收付人／專案。每次都在同一 DB transaction 內刪除並重建所有分錄。
- `DELETE /transactions/:id`：刪除交易，FK cascade 刪除分錄。
- `POST /transactions/preview`：使用與建立相同的驗證與 calculateBaseAmounts，不寫入；編輯時使用 `POST /transactions/:id/preview`，檢查原日期的關帳與既有封存參照。
- `GET /exchange-rates?date=YYYY-MM-DD`：取得該日、該帳本、轉成本位幣的參考匯率。沒有當日資料時不猜測其他日期或反向匯率；B/D 須手動輸入。匯率維護／下載不在此批範圍。

寫入欄位：`occurred_on`、`memo`、`payee_id`、`project_id`、`invoice_no`、`entries`。
每個 entry 只有 `item_id`、字串 `amount`、可省略的字串 `exchange_rate`；currency 取自科目，base_amount 與 kind 不接受客戶端指定。2–100 筆分錄，摘要最多 2000 字元、發票號碼最多 100 字元。

金額完全使用 ADR-0002 的 calculateBaseAmounts。A 為本位幣精確零和；C 由實際本位幣扣款及外幣原額決定有效匯率；B/D 使用當日參考值或手動匯率，逐分分攤。C 的參考值只供偏離警告，手動輸入不覆寫有效匯率。依 ADR-0002 rev.2.2，警告先比較該外幣 entry 的使用者輸入匯率，未輸入才比較當日 exchange_rates，兩者都無則不比較。快速記帳跨幣時須分別輸入來源／目的實際原幣金額。

kind 優先順序為 income → expense → transfer（至少兩筆且全為 asset/liability）→ adjustment。

封存資源不允許新增使用。修改既有交易可保留原封存收付人／專案；封存科目的分錄必須與原筆相同（item、amount、effective rate、base amount），且不能複製為額外分錄，仍可修改其他欄位。帳本鎖在整筆操作期間持有，與封存／其他帳本操作串行。locked_until 包含截止日；更新同時檢查舊日期及新日期，禁止移出已關帳交易。

錯誤碼：`invalid_input`、`invalid_money_entry`、`unbalanced`、`fx_residual_exceeds_tolerance`、`base_amount_rounds_to_zero`、`exchange_rate_missing`、`archived_resource`、`item_ledger_mismatch`、`payee_ledger_mismatch`、`project_ledger_mismatch`（400），`period_locked`（409），非本人或不存在（404）。

每次成功建立、修改、刪除與服務驗證失敗均沿用 core mutation audit。稽核僅記 user/action/outcome；不包含金額、摘要或分錄。HTTP log serializer 也不記 body。0006 新增 entry_position，舊資料以 id 排序回填；既有 SQL 客戶端省略 position 時由 trigger 配置。沒有修改 0001–0005。

## 快速記帳 UI 與可重跑驗證

「交易記帳」提供來源貸方 −X、目的借方 +X，同幣時只輸入一次金額；跨幣時分別填寫兩側實際原幣金額。先試算，再儲存；修改任何欄位即須重新試算。C 顯示有效匯率，偏離選定參考值超過 5% 須勾選確認，仍允許儲存。編輯既有交易會保留原有手動匯率；修改日期時重新帶入當日參考。含封存科目時，分錄唯讀，可修改其他欄位。

Playwright 為固定版本 devDependency，CI 的 db-integration job 執行相同測試並保存截圖：

```bash
pnpm install --frozen-lockfile
pnpm build
bash deploy/setup-dev.sh
pnpm exec playwright install chromium
TEST_DATABASE_URL=postgresql://synthetic@localhost:5432/synthetic pnpm test:ui
```

測試只接受 localhost 且 DB 名稱為 synthetic 或 life_test；使用合成 owner／帳本／科目與真實 DB session。以隔離瀏覽器接受本機合成 TLS certificate，不使用個人瀏覽器或真實資料。輸出 `test-results/transactions/*.png`（gitignored），含 390px C 警告、完成清單與 desktop；`CHROME_BIN` 可指定本機測試 Chrome，`UI_OUTPUT_DIR` 可改輸出位置。執行後須停止自己的測試 PostgreSQL，合成 volume 可清除。

## 進階多分錄

「進階多分錄」接受 2–100 筆，逐筆選科目、輸入有正負號的原幣金額及手改匯率。空白匯率沿用當日參考值。由 API 的同一 calculateBaseAmounts 試算；分錄不自動新增匯兌損益科目。試算結果顯示每筆 base_amount、儲存匯率與推導 kind。新增／移除／改值後須重新試算。編輯不適用兩腿快速模式的交易時自動進入進階模式，保留分錄順序與逐筆匯率。切回快速模式會明確清除表單。

本批 Playwright 增加：三腿 [0.005,0.005,-0.010] → [0.01,0.01,-0.02]；編輯並移除一腿後整筆替換、原 entry IDs 全數消失；三種金額錯誤的中文訊息；手改匯率的 metadata 修改仍保留原匯率；封存科目／收付人／專案的既有交易試算與 metadata 編輯、cascade 刪除。截圖另含 advanced-residual-390.png。

## ADR-0002 rev.2.2：情境 C 偏離比較

試算（包含既有交易試算）、建立、修改回應新增 `fx_comparisons`；A／B/D 為空陣列。C 有一筆：

```json
{
  "entry_index": 0,
  "effective_rate": "40.0000000000",
  "reference_rate": "32.5000000000",
  "reference_source": "user_input",
  "deviation_percent": "23.0769230769"
}
```

`reference_source` 是 `user_input`、`exchange_rates` 或 `none`；none 時 reference_rate／deviation_percent 為 null。偏差為 `abs(effective-reference)/reference*100` 的非負百分比字串，在既有 BigInt 金額引擎內 HALF_UP 到10位小數；>5%警告仍以未取整的整數比例判斷，正好5%不警告。計算本位幣與有效匯率的演算法不變。只改 metadata 的 PATCH 沒有輸入 entry rate，不將舊有效匯率偽稱為使用者參考，改用當日值或 none。

UI 區分自動帶入的當日匯率與真正手填的值：未修改的預設值不回傳為 entry exchange_rate；清空手填值回退當日資料。進階模式相同。試算必須顯示有效匯率、參考來源／值與偏差（或明確不比較），確認偏離警告後仍可儲存；所有欄位變更都須重新試算。封存編輯仍以唯讀原分錄完整送出，確保試算與儲存的比較來源一致，service 繼續拒絕任何修改封存分錄金額的請求。

依 ADR，DB 只保存有效匯率，沒有保存原輸入參考與偏差歷史；fx_comparisons 是本次請求的即時計算資訊，GET 歷史交易不重建原輸入值。無 migration 變更。HTTP 與 Playwright 涵蓋 USD−100、輸入32.5、TWD4000（無當日資料也警告23.0769230769%）、當日fallback（22.8237172598%）、5%內（0.0307692308%不警告）；另測正好5%、無參考、無效顯式匯率與 metadata-only 的來源。
