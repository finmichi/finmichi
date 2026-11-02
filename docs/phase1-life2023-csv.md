# Life2023 8 欄 CSV（ADR-0006 rev.1.1）

固定表頭依序為：記錄日期、來源項目、目的帳目、異動金額、摘要、收付人、專案代號、發票號碼。UTF-8（含／不含 BOM）與 CP950 自動判定，無法無損解碼時要求手選編碼；日期只接受 YYYY/MM/DD 或 YYYY-MM-DD，金額去掉千分位逗號／前後空白後必須為正數、最多 2 位小數。金額全程使用字串與 BigInt，範圍沿用 numeric(20,6)。

## 匯入 API

`POST /api/ledgers/:ledger/imports/life2023/preview` 與 `/confirm` 共用 payload：

- `file_base64`：原始 bytes 的標準 Base64（最多 4 MiB／10,000 筆）；`encoding`：auto、utf-8、big5。
- `item_mappings`：key 為 `source:<trim/lowercase name>` 或 `destination:<trim/lowercase name>`，value 為 `{mode: "existing", id}`，或 `{mode: "create", data: {name, kind, ...}}`。新增幣別固定為帳本本位幣，可指定同 kind 父科目、旗標。不同角色可分別對應，避免同名不同 kind 被猜測。
- `payee_mappings`／`project_mappings`：key 為 trim/lowercase name，value 為 existing/id、create 或 blank。缺少名稱時預設新增；封存資料不接受。
- `skip_invalid`：預設 false。有錯誤列時，明確選 true 才提交無錯誤列；選擇與列號／錯誤碼存入 import_jobs.report。

preview 不寫 DB，回傳資料列、錯誤／可匯入／疑似重複筆數、金額合計、對應候選與待新增數量。列號是 CSV 實體起始行，含換行摘要不影響追蹤。confirm 重新解析原檔、取得帳本鎖、驗證對應／封存／關帳，在單一 DB transaction 建立資料、兩分錄交易、import job 與來源紀錄；任一步失敗全部回滾。計算與 kind 推導共用 transaction service 的 calculateBaseAmounts 路徑。

Server 計算原始 bytes 的 SHA-256，ledger + SHA 已匯入則 409 already_imported；並行 confirm 由 ledger lock 與既有 unique index 防重。不同 bytes 可匯入，但日期／兩個科目／金額／摘要完全相同時標示疑似重複。audit 只記 life2023.import 的結果，不保存金額、摘要或 CSV 內容。

## 格式限制與往返前提

8 欄不含 kind、科目樹、幣別與旗標。往返目標帳本必須尚無交易，並先建立與來源相同的科目樹、kind、幣別與旗標；依名稱對應既有科目，多筆候選必須手選。

文字欄位沿用 formula injection 防護；Life2023 CSV 匯出的文字若以 = + - @ 開頭（含前置空白／控制字元）會加上 `'`，重新匯入保留該字元，不自動移除、也不模糊比對名稱。主要往返 fixture 的科目名稱不使用這些開頭；獨立案例需將 `'=餐費` 明確對應回既有 `=餐費`。

合成 UTF-8／Big5 範例在 fixtures/life2023，兩者含千分位、引號、逗號與換行摘要。CP950 檔案是二進位編碼，請勿用 UTF-8 編輯器覆存。未讀取真實財務資料。

## 匯出與往返驗證

查詢頁的「匯出 Life2023 CSV」沿用已套用的所有篩選，條件尚未套用時停用。API 為 `GET /api/ledgers/:ledger/transactions/life2023-export`，回 JSON：csv（UTF-8 BOM／CRLF）、exported_count、skipped_count、skip_reasons；同一 transaction 取得帳本與完整查詢結果，client 將 csv bytes 下載為 life2023.csv。日期 YYYY/MM/DD，金額 typed numeric，無千分位且 2 位小數。文字防護沿用 PR #27。

只匯出兩分錄且皆本位幣的交易；多分錄優先列為 multiple_entries，其餘外幣列為 foreign_currency，每筆略過交易只計一次。畫面顯示筆數／原因並提示改用分錄 CSV。

往返測試透過 API 建立相同科目樹與自身旗標，再以 HTTP 匯出／確認匯入。比對交易數與 (日期、來源、目的、金額) 集合；未觸發防護的摘要（含引號／逗號／換行）逐字相同，摘要／發票／收付人／專案觸發防護時明確斷言多一個 `'`，原本就有的 `'` 不移除。三張 SQL 報表僅排除必然不同的 ledger UUID、generated_at，並以 kind+name 對應科目 UUID／parent UUID 後完整比對；分類另覆蓋所有營業／固定性篩選組合。
