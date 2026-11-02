# P1.6 第二批：總覽與明細

依 UX rev.1.2 與 Claude PR45 review 第1、2項，本批完成首頁與明細的新內容，移除兩頁的舊 Tabs／帳本管理區塊。手機頂部帳本為精簡標籤，點擊選單顯示完整名稱、幣別與目前選擇。其他管理／報表頁的舊內容依 PR4／5 接續搬移。

## 資料與口徑

總覽同時讀取既有 balance-sheet（臺北今天）、income-summary（三個月、末日今天）、category-statistics（本月expense）與 transactions（最近7筆）。沒有新增endpoint／SQL，既有 owner隔離、財務及audit不變。收入／支出包含營業與業外；KPI、資產／負債與淨值直接用報表值。比較顯示上月數值，儲蓄率為本月結餘／收入，收入0時顯示「—」。合成負值圖條以絕對長度繪製，旁保留帶號值；分類圓餅遵守 report.pie_available／pie_reason。首頁使用 CSS bars／SVG 圖，不載入 ECharts。

明細的交易金額、kind與篩選口徑沿用ADR0004：正分錄base合計；支出在畫面加負號、收入加正號。標題的收入／支出與手機日淨額採損益口徑：既有 `/transactions/summary?group_by=item` 的 income／expense 科目自身 `natural_amount` 加總，淨額為收入減支出，不加總 rollup，也不按交易類別累加交易金額。篩選含科目時，標題與每日改顯示「科目淨變動」，取 `totals.selected_net_amount`。每日讀取相同篩選加當日日期範圍的 summary，並行最多4個請求、依篩選及日期快取；涵蓋未載入的交易，未取得時顯示「—」。字串／BigInt僅做展示加總／比例，沒有新增任何外幣換算邏輯；圖形幾何才使用bounded比例數字。

## 互動

- URL allowlist保存所有AND篩選；重新整理、瀏覽器返回還原，未知query keys不送API。金額條件仍由既有API驗證。
- 桌面表格、手機日期卡片共用資料與KindChip；多分錄展開、外幣原幣與4位匯率／完整10位title、收付人／專案／發票／selected net皆保留。
- Cursor「載入更多」累加並依ID去重；變更篩選／每次載入筆數／檢視時重設cursor。回到頂端以main scroll為基準。
- 預設維持API日期／建立時間穩定排序；可排序**已載入**日期或金額，畫面明確提示範圍，避免宣稱是尚未取得的完整資料排序。
- 桌面寬表格使用共用EdgeScroll雙向箭頭、sticky表頭／第一欄；手機首屏只留搜尋（Enter套用）與可水平捲動的類別晶片（點擊即套用）；其餘條件、已套用條件、每次載入筆數、排序、檢視與CSV移入「篩選與工具」底部面板，按鈕顯示已套用條件數。KPI數字16px且不換行，手機改兩欄，月份標籤不換行。兩分錄不顯示展開按鈕，手機僅保留類別標籤。CSV選單保留明細、分錄與Life2023三種，沿用typed numeric／formula guard，按目前**已套用**篩選匯出全部結果，不受目前載入頁數影響。
- 點列／卡片透過entry query開啟右側抽屜／手機全螢幕編輯，保留原頁、篩選與捲動；未儲存確認與就地新增見 [第三批記帳說明](ux-entry-editor.md)。未擴充記帳寫入規則。
- 首次骨架、查詢中提示、失敗重試與空帳本／無符合結果狀態。僅PR2頁面處理本批狀態，全站Toast／ConfirmDialog仍屬PR5。

## 驗證與回復

`pnpm check`、`pnpm test:db`、既有7組UI、`pnpm test:ux-foundations`與`pnpm test:ux-daily`；兩組UX矩陣均由CI上傳PNG／JSON。rev.1.2加入混合分錄回歸：現金−300／支出+200／銀行+100，另同日支出220；日淨額−420、本月支出3420，總覽與明細相同；科目篩選改為淨變動；四尺寸雙主題檢查KPI／月份不換行與手機首屏至少3張完整卡片。新增daily測試包含四尺寸×雙主題、長帳本名稱、負債／外幣／多分錄、30筆cursor累加、URL reload/back、filter reset、CSV全量與手機進階面板、空帳本及編輯入口。

回復可revert此PR，沒有migration或資料變更。完成本批後停下等Claude驗收；PR3、P2與NAS部署需後續指示。
