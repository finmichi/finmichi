# Phase1.4 查詢契約（ADR-0004）

口徑：交易查詢與報表的服務契約及自動化測試。所有金額為本位幣十進位字串；SQL numeric與BigInt，不使用float。

`GET /api/ledgers/:ledger/transactions` 回傳 `{items,next_cursor,totals}`，取代舊100筆陣列。支援 `date_from`、`date_to`、`item_id`（所有子孫）、`project_id`、`payee_id`、`keyword`（摘要或發票，不分大小寫，字面部分比對）、`amount_min`、`amount_max`、`kind`，全部AND、邊界包含。歷史封存資源可選；不存在或其他帳本的篩選資源404。

交易金額是所有正base合計；有科目篩選時另回傳該子樹帶號selected_net_amount。每筆含全部分錄（含item_name／item_kind、原幣、rate、base、entry_position），供展開與對帳。

`limit` 每頁1–100，預設25；全體結果無100筆限制。排序固定occurred_on DESC、created_at DESC、id DESC。cursor綁定owner、ledger及所有篩選，跨條件或損壞回400 invalid_cursor；跨使用者先檢查owner，回404。created_at使用六位微秒文字，游標timestamp參數先以text綁定再由PG轉timestamptz，避免postgres.js Date序列化截斷微秒。固定資料下各頁順序完整穩定；並非跨請求的歷史快照，期間日期／科目樹被修改時請重新查詢。

`totals` 是完整篩選結果（不受cursor影響）：count、by_kind的筆數與交易金額、選科目時的selected_net_amount。不同交易類別不混加成單一金額。

`GET /transactions/summary` 使用相同條件並加 `group_by=item|month`，不接受cursor／limit。month依月份×kind輸出筆數與交易金額；有科目篩選另給monthly_net。item在選科目時只計子樹分錄，否則全部分錄；含signed_amount、natural_amount（liability／income／equity反號）、rollup_signed_amount／rollup_natural_amount，含有子孫紀錄但無直接紀錄的父節點。未選科目時直接signed_amount合計為0；rollup不可再次加進直接合計。

所有搜尋、summary、內部全量查詢均在core先驗owner，再驗篩選與cursor，使用同一組參數化CTE。每次讀取持有該ledger lock，單次回應的明細／totals一致。0007僅新增排序及科目分錄索引，0001–0006不改。

驗證包含ADR T1–T3全預期值、3組獨立直接SQL筆數／金額比對、含孫科目、自然方向與父節點rollup、歷史封存、owner HTTP/core404、字面關鍵字、壞範圍／cursor、127筆同日同微秒的keyset完整順序。CSV與查詢UI由後續獨立PR完成。

## 查詢介面

「交易查詢」頁籤以同一組已套用條件切換明細與彙總，日期、科目子樹、專案、收付人、關鍵字、金額、類別都可組合。修改條件後須按「套用篩選」；清除條件會回到第一頁。明細每頁 1–100 筆，以 cursor 記錄上一頁／下一頁，沒有總共 100 筆的限制。多筆分錄可展開所有分錄。

科目彙總預設 natural_amount，可切換 signed_amount；父科目同時顯示自身金額和子樹 rollup 小計，不能把小計與明細重複相加。月份依類別分組，有科目篩選另顯示月份淨額。390px Playwright 驗證所有條件 AND、子科目、分頁往返、多分錄展開、彙總及水平溢出。

## CSV

`GET /api/ledgers/:ledger/transactions/export.csv?format=detail|entries` 接受完全相同的交易篩選（不接受 limit/cursor）。沿用 queryService.all 的 CTE、owner 檢查及排序，全量匯出，不受目前明細頁限制。明細依 ADR §7，選科目時增加所選科目淨額；分錄格式保留每筆符合交易的全部分錄，科目篩選只選交易，不裁掉其他腿。

UTF-8 BOM、CRLF、所有欄位雙引號且內含雙引號加倍，保留摘要換行。使用者文字欄位（摘要、發票號碼、收付人、專案、科目名稱與科目方向文字）在空白／控制字元後以 `= + - @` 開頭，最前面加單引號，包含純數字摘要 `-123`。系統數值欄位（交易金額、所選淨額、原幣金額、匯率、base_amount）另以型別標示來源，只在符合 `^-?\d+(\.\d+)?$` 時不加前綴，因此 `-1000.00` 可直接作數值匯入／加總；非合法數值仍回到文字防護。HTTP 回應 attachment 並設 no-store。UI 僅匯出已套用條件；條件草稿變更時暫停下載。

目前全量 CSV 在記憶體產生，尚未提供串流或背景匯出；適用個人帳本，超大資料量的記憶體上限尚未負載驗證。repo devDependency csv-parse 的 Node parser 驗證 BOM、105 筆完整結果、引號／逗號／換行、數值／文字來源、公式前綴、篩選一致與權限隔離；390px Playwright 實際下載明細／分錄並解析內容。

## Node container DB 驗證

CI 的 db-integration 在 Dockerfile 的 build stage 內執行 pnpm test:db；該 stage 沿用 repo 固定 digest 的 node:22-bookworm-slim，沒有安裝 Python。測試先確認 python3 不存在，CSV HTTP／DB 與 Playwright 皆使用 pinned csv-parse devDependency（cast:false，金額維持字串）。Docker build context 不含 deploy/local、.env 或 host node_modules，測試只連接專用合成 PostgreSQL container；結束移除該 DB。
