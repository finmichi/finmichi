# 報表（brief 1.5，非 MCP P1.5）

依 ADR-0005。SQL view `report_entry_facts` 以 owner_id/ledger_id 串接分錄、交易日期與科目目前旗標；`natural_amount` 對 liability/income/equity 反轉。API 與未來 MCP 應共用 core reportService，不能另寫口徑。SQL function 是 SECURITY INVOKER，帶 owner/ledger，未擁有帳本回 null；core 在驗證參數前核對 owner（404），在同一 transaction 內以 ledger lock 配合既有 mutation 取得一致資料。

## ④ 資產負債表

`GET /api/ledgers/:ledger/reports/balance-sheet?as_of=YYYY-MM-DD`；`.csv` 同條件匯出。0008 新增 view/function，不修改舊 migrations。只按 occurred_on ≤ as_of，包含期初、轉帳、封存資料；金額依分錄科目 kind，與交易 kind 無關。總計從自身分錄加總，不重複加父節點rollup。回傳 assets/liabilities/net_worth/equity/net_income/identity_difference/is_balanced，API 的 numeric 全為字串。

items 包含 asset/liability/equity 樹：own_book_amount 為自身自然方向，book_amount 含所有子孫。own_original_amount 是該科目原幣 Σamount（保留借貸符號）；original_balances 依子樹幣別分組，各有原幣餘額與本位幣帳面值，絕不把不同幣別相加或依當日匯率重估。父子幣別可不同；credit_card/loan 旗標不改變 kind 分組。

390px 使用可展開卡片；變更基準日重新產生報表。CSV 含基準日／產生時間／kind／科目／本位幣／自身與rollup帳面值／科目幣別／自身原幣餘額，另有總計列；自身、rollup、總計不能重複相加。沿用 PR27 共用 typed numeric encoder：系統數值不加前綴，所有使用者文字維持公式注入防護，UTF8 BOM/CRLF/RFC quoting。CSV 全量於記憶體產生。

驗收：ADR T0–T5（10月底43930＝10000＋33930，11月轉帳後不變）、期初前零值、祖先rollup、外幣歷史多匯率／當日匯率不重估、混幣父子、負債信用卡／貸款旗標、封存、owner HTTP/core/SQL隔離及CSV。Playwright390px實際操作日期、樹、外幣、下載、水平溢出。

## ① 收支彙總

`GET reports/income-summary?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&grain=day|month|quarter|year`，`.csv`同條件。0009 的SQL function以generate_series產生連續時段，calendar quarter/year，第一／最後時段裁切到含邊界的查詢期間。只加總收入／支出分錄自然方向；業外判斷科目自身旗標，不繼承父節點，不使用交易kind。期間合計由各時段加總。API全部numeric字串，含期間與generated_at。

卡片顯示營業／業外收入與支出、收入與支出合計、淨收支，沒有交易或只有轉帳／權益的時段仍補0。CSV每時段一列與期間合計列，負淨收支維持數值。DB驗證T0–T5、跨日／月／季／年、閏日、部分時段裁切、混合收入支出同筆交易、非營業支出、SQL/API一致、owner404及CSV；390px驗證零交易月份、季粒度、匯出與無水平溢出。

## ② 分類統計（ADR-0005 rev.1.2）

`GET reports/category-statistics?date_from=...&date_to=...&kind=income|expense&non_operating=all|operating|non_operating&fixed=all|fixed|variable`；`.csv`同條件。0010 新SQL function從共用facts依分錄自身旗標篩選；輸出自身／rollup／占比與非零小計科目的祖先，零小計祖先不丟棄。葉節點定義依完整科目樹，前十名按abs(rollup)降冪、名稱C collation與id穩定排序。

百分比 `report_percentage` 用numeric div的精確整數商做rational HALF_UP至10位，避免先做有限精度除法造成二次rounding；不分配尾差。金額根小計精確等於T；API提供root_percentage_sum、percentage_tolerance=n×1e-10及是否在容差內。T≤0百分比全部JSON null，CSV為空欄，不假裝0；畫面2位，不強制合計100。

T>0全無負值才顯示第一層圓餅；任何可見科目含負rollup都停用圓餅並顯示指定訊息。T=0與T<0顯示「不適用（總額為 0／負）」；長條維持帶號。ECharts6.1.0模組化lazy載入，長條以SQL給出的無量綱chart_weight（-100～100）做零點置中；僅圖形座標轉Number，金額、排序、百分比、標籤與CSV一律取SQL numeric字串／BigInt，不把圖表浮點結果寫回財務資料。Canvas/richText tooltip，科目名稱不作HTML。圖表依ResizeObserver調整寬度，負值標籤放條內避免與科目名稱重疊。

三張報表都支援同條件再次按「產生」刷新；改過未套用條件時停用CSV。DB驗證T0–T5、旗標不繼承、封存、六種占比邊界、根金額精確相等／百分比容差、正負tie、前十絕對值／名稱排序、零小計祖先、owner/API/SQL/CSV。Playwright390px驗證三張報表、三種CSV實際下載、正值圓餅／負值雙向長條／零與負總額null、旗標、同條件刷新與無水平溢出。收支測試的moneyUnits呼叫也移除無效的第二參數（原函式固定6位，驗算口徑不變）。

已知限制：全量CSV與報表尚未做大資料量效能驗證；圖表lazy chunk約530KB（gzip約181KB），Vite提供非阻擋大小提示，未提高或關閉門檻。
