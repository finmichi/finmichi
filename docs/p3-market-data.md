# P3-1 市場資料與只讀重估

依 Workspace ADR-0012 rev.1.3。只含市場快取、外幣重估與股票估值純函式；股票模型與整合留待 P3-2。所有測試 fixture 為合成資料，CI 不連行情來源。

## 資料與權限

`0023_market_data.sql` 新增 `market_fx_rates`、`market_prices`、`market_calendar`、`market_fetch_runs`。這些是共用公開牌告快取，不屬帳本、不進 JSON 備份。帳本讀取與上傳入口先檢查 owner；跨使用者為 404。手動上傳只接受 cookie session 與相同 Origin，PAT 無寫入入口；audit 僅記 `market.fx_upload` action／結果，不記 CSV、檔名、數值。

- `GET /api/ledgers/:id/market`：最新各幣別牌告與來源狀態、實際資料日期、過期／平日估算標記。
- `POST …/market/fx-preview`：`{filename, content, rate_date?}`；嚴格解析、無寫入。
- `POST …/market/fx-upload`：同契約，確認後原子更新快取；較舊日期不改寫已存資料。最多 1,000,000 字元，UI 同時限制 1,000,000 bytes；HTTP 另沿用既有 body 上限。

管理中心「匯率」提供預覽、取消、確認上傳。UTF-8 BOM／21 欄臺銀 CSV 與自動抓取使用同一 parser。表頭或資料列超出 21 欄時，只允許尾端空字串／空白欄（例如表頭 21 欄、資料 22 欄的尾逗號）；非空多餘欄、缺欄及原欄位驗證失敗仍整批拒絕。檔名 `ExchangeRate@YYYYMMDDHHmm.csv` 優先；其他檔名必填掛牌日期，沒有預設今天。0 表示不提供，存 null；只使用現金、即期四欄。

## 排程與來源邊界

worker 的 `MARKET_DATA_ENABLED=true` 才啟用（預設 false）；CI 即使誤設也不啟用全球 fetch。只接受程式內固定 HTTPS URL：

- `rate.bot.com.tw/xrt/flcsv/0/day`
- `www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data`
- `openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule`
- `www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes`

不接受任意 URL、不跟隨 redirect、不送 cookie／credential。20 秒逾時、8 MiB 串流上限、嚴格解析後整批 transaction 寫入；只保留安全錯誤碼。每個來源以 DB row lock claim，避免多 worker 重複執行，同日更正可以更新，舊日期不覆蓋新日期或 fetched_at。

Asia/Taipei 平日 10:00／16:30 匯率、15:00 後股價；月初（或本月首次啟動）更新當年／次年日曆。已知休市日略過股票來源；缺年度的日期照平日嘗試及估算，沒有新股價並非失敗。來源尚未發布當日股價時 30 分鐘後再看；錯誤沿用 worker 退避。主機停機後只補當前可用時段，無法重建來源未提供的歷史掛牌。

臺銀非 CSV／HTML 挑戰／redirect 記 `blocked_by_source`，當日最多兩次，沒有繞過挑戰。可由使用者自行下載公開牌告後手動上傳。`first_success_filename` 只記自動成功的實際檔名；合成測試不代表已驗證真實 HTTP 回應。dev 的臺銀挑戰與 TPEx 逾時已記 Workspace；正式環境三來源連線與首次檔名須另作部署驗證。

## 行情錯誤診斷（v0.2.1 PR-K）

每次抓取失敗會輸出一行 JSON：`event=market.fetch`、`source`、`code`、`failure_count`、`next_retry_at`。不輸出原始錯誤訊息、response body、cookie 或 token。`failure_count` 沿用既有退避計數；`blocked_by_source` 另以每日 attempts 控制，沒有改成無限重試。

`GET /api/ledgers/:id/market` 的來源狀態包含既有 DB 欄位 `next_retry_at`（UTC 字串或 null）。管理中心「匯率」顯示中文錯誤說明、原錯誤碼與台北時間的下次重試；當日挑戰重試已用完時，引導手動上傳。讀取不寫 DB，也沒有新增 migration。

| code                | 意義                                          |
| ------------------- | --------------------------------------------- |
| market_data_invalid | 來源格式不符合欄位契約                        |
| source_date_missing | 回應中沒有可驗證來源日期                      |
| dns_failed          | `error.cause.code` 為 DNS 解析失敗            |
| tls_failed          | TLS／憑證驗證錯誤                             |
| connection_refused  | 來源拒絕連線                                  |
| source_timeout      | 超過既有 20 秒上限                            |
| source_unavailable  | 無法辨識的傳輸錯誤，保留通用分類              |
| blocked_by_source   | 非 CSV／HTML challenge／臺銀 redirect；不繞過 |

傳輸分類依 Node 的結構化 cause code，不比對外部錯誤文字。[Node 22 error codes](https://nodejs.org/download/release/latest-jod/docs/api/errors.html)。所有驗證僅使用合成 CSV／HTTP 回應；真實臺銀首次成功仍須獨立 evidence。

## 計算口徑

參考匯率依序：使用者輸入 → 帳本當日 `exchange_rates` → 基準日或之前最近市場即期中價。只有一側牌告時用該側；兩側皆無時無市場參考。非 TWD 本位幣 X 採同源、同日兩腿的最近共同日期：C→X = mid(C/TWD) / mid(X/TWD)，TWD→X = 1 / mid(X/TWD)，HALF_UP 10 位。全程 BigInt 十進位字串，不經 float；交易仍統一呼叫既有 `calculateBaseAmounts`。

資產負債表保留原 SQL 帳面值、恆等式與 CSV 欄位口徑；另加市值／未實現損益欄與市值淨值 KPI。外幣自身原幣餘額乘市場匯率，負債／權益轉自然方向，再 rollup；淨值 = 市值資產 − 市值負債，不把父子重複相加。缺行情回到帳面值並標示，行情日期及過期提示可見。市值不產生分錄，不影響帳務、預算、貸款、信用卡或歷史報表。現有 CSV 仍匯出歷史帳面值，沒有宣稱輸出新市值欄。

FX 一律依平日計過期；股票依交易日曆、缺漏日依平日估算。從資料日期之後算到今天之前，超過 3 個應有日期才提示。P3-1 沒有股票旗標或持股模型，顯示「股票市值將於投資功能上線後提供」；`valueHoldings` 只有純計算與單元驗證。

## 驗證與復原

`pnpm check`、`pnpm test:db`（隔離合成 PostgreSQL）、`pnpm test:ux-market`。UX 矩陣涵蓋 1440×900／1280×800／390×844／360×780 各淺／深色，重估、缺行情、交叉匯率、過期、上傳與各狀態，檢查 axe 與水平溢出。獨立 Python Decimal 結果錄製成合成 JSON oracle，CI 另以 PostgreSQL numeric 對照；不依賴宿主 Python。

停止自動抓取可把 worker 的 `MARKET_DATA_ENABLED` 設為 false 後重建 worker；原帳務完全不受影響，仍可讀快取／手動上傳。migration 只新增，不移除 constraint、不倒改舊 migration。需要退版時先停用 worker 抓取，保留新增快取表，回退 app image；不要刪帳務資料。

## v0.2.2 PR-Q：證交所 CSV 與帳本缺價提示

TWSE 價格改讀上述唯一官網 CSV URL；不再以舊日期 OpenAPI 作為價格來源，也沒有新增任意 URL 或備援重導。新增 `www.twse.com.tw` host 只為這個完整 URL。CSV 檢查固定 11 欄表頭、每列欄數、民國 7 碼日期及全批同日、證券代號、收盤價；BOM、引號與合法千分位可接受，空白／`--` 缺價略過並計數，其他格式錯誤整批拒絕。資料日期來自 CSV，不以今天補值；舊日期仍不能蓋過新快取。

TWSE HTML／challenge 回 `blocked_by_source`，沿用每日最多兩次的阻擋重試上限，不繞過。匯率頁會分辨臺銀的手動上傳提示與其他行情來源的阻擋訊息。

`GET /api/ledgers/:id/market` 新增 `price_coverage`：每個股票來源的 `data_date`、`tracked_securities`、`missing_prices`。日期取不晚於今天的來源最近已接受日期（包含整批缺價的日期）與快取日期的較新者；依目前帳本的未封存 `securities` 比對該來源、該日期的價格，不因其他帳本／封存證券而提醒，也不以整體缺價比例代替帳本檢查。尚無來源日期時，已追蹤證券視為缺價。這是來源完整性提示，手動價格與原有估值規則完全不變。整體 skipped 數量保留在來源狀態與可展開明細，不再直接觸發帳本警告。既有 owner 檢查、跨使用者 404、唯讀無寫入沿用並測試。

### 官方來源與使用條款查證（2026-11-01）

政府資料開放平臺的 [盤後資訊 > 個股日成交資訊，資料集 11549](https://data.gov.tw/dataset/11549) 列出本 CSV 的 11 欄與相同下載 URL，標示免費、每日更新、採 [政府資料開放授權條款第 1 版](https://data.gov.tw/license)。條款允許利用及製作衍生物，要求顯名，且不代表提供機關推薦或保證本產品。來源標示：金融監督管理委員會證券期貨局／臺灣證券交易所，2026，盤後資訊 > 個股日成交資訊；依 Open Government Data License v1.0 釋出。這次查證是公開資料集與授權頁，不代表未來每次抓取都會成功。

本 PR 不新增 migration、不改交易／估值口徑。回退 app／worker 即可還原行為，既有行情與帳務表不需改動。CI 只用合成 HTTP／CSV fixtures；實際交易日來源驗收由 Claude 在隔離環境執行。
