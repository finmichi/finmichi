# P2-3A 預算與報表③

依 Workspace ADR-0010 rev.1.1 §3–§6；本批先完成預算與報表，下一 PR 才處理 ADR-0007 rev.2 備份及 PR52 worker／卡片後續。新 migration0018，不修改已合併的0017或其他migration。

## 金額與寫入

`budgets` 以 `(ledger_id, year, item_id, month)` 唯一，amount 為 `numeric(20,2)` 非負自然方向；DB trigger 及 core 同時限制收入／支出科目，FK 強制同帳本。item kind 更新也不能破壞既有預算。封存科目仍可供預算與歷史報表檢視。

年度分攤依085154d正式補正：總額必須為非負字串、最多2位小數，不接受負數、JSON number、第3位小數或超出numeric(20,2)範圍。以BigInt整數分計算 `base=T/12`（向下）、`r=T%12`，1–11月base，12月base+r。1000→83.33×11＋83.37；0.06→0×11＋0.06。整個計算不經過浮點；12筆在同transaction內upsert，之後可逐月修改。

所有mutation先owner檢查＋帳本row lock；錯誤整批回滾。audit `budget.update`、`budget.delete` 只記action／outcome，DB CHECK／core／UI篩選同步，不記金額、科目、年度或其他payload。

## REST

前綴 `/api/ledgers/:ledger/budgets`，既有session／Origin／owner隔離不變。

| 方法／後綴         | 輸入與結果                                                                       |
| ------------------ | -------------------------------------------------------------------------------- |
| GET 根路徑         | `year`，回傳該年已設定的月預算（含id、item_id、month、amount字串）               |
| PUT 根路徑         | `{year,item_id,months:[{month,amount}]}`，1–12筆、月份不得重複；只upsert指定月份 |
| POST `/distribute` | `{year,item_id,total}`，原子寫入12月預算                                         |
| DELETE 根路徑      | `year,item_id` query，清除該科目該年全部預算；不刪交易                           |

報表：GET `/api/ledgers/:ledger/reports/budget-vs-actual`（CSV加`.csv`），參數 `year`、`grain=month|quarter|year`、`kind=income|expense`、`non_operating=all|operating|non_operating`、`fixed=all|fixed|variable`。

SQL function `report_budget_vs_actual` 同時驗owner並重用 `report_entry_facts` 自然方向。先按科目／時段彙總預算與實際，再用同kind科目closure計算rollup；篩選各自依預算科目／實際分錄科目自身旗標。祖先保留作小計，即使自身旗標不同。總額只加自身值，避免父子重複加總；父子各有預算時兩者都計入，UI提示。

回應含全年totals與每期（12月／4季／1年）totals及tree items：budget_own、budget_rollup、actual_rollup、variance、achievement。差異＝實際−預算；達成率重用SQL精確HALF_UP10位，預算0時null。沒有金額的科目不列，但有金額科目的祖先保留；空時段仍回傳0合計。所有金額／百分比為字串。

## UI／MCP／CSV

`/admin/budgets`：桌面科目樹×12月表，第一欄sticky、EdgeScroll雙向；手機選科目後列12月。年度分攤／儲存／清除（ConfirmDialog）、重試／Toast／Loading／Empty沿用，父子預算提示不阻擋。

`/reports/budget-vs-actual`：全年KPI、時段選擇與TreeTable、各期預算／實際長條圖。正差異的支出加上「超支」文字與`--expense`，不只靠顏色。條件寫入URL且以allowlist還原，Enter產生，CSV使用已套用條件。手機以卡片顯示，新增第4報表分頁用EdgeScroll以免溢出。

MCP `get_report` 新增同名report，直接呼叫同一core service；不提供寫入工具。保留PAT帳本scope、mask_text、1MiB輸出限制與每次一筆mcp.call audit。ADR-0009的科目名稱／數值不遮罩，摘要／發票／收付人／專案仍依既有規則遮罩。

CSV使用UTF-8 BOM與既有typed numeric：系統金額保留負號數值，科目名稱等文字繼續formula injection防護。含每期合計與全年合計，不能將科目rollup逐列相加視為總額。

ECharts lazy載入、全token配色；座標先以BigInt正規化，再轉dimensionless Number，tooltip及表格／CSV始終保留原精確字串。沒有新增套件依賴。

## 驗證與交接

property test驗任意0–999999999.99總額，12月合計、非負與12月餘數；HTTP／DB驗輸入錯誤原子性、parent/child、零預算、旗標、三粒度、與報表①②一致、CSV防護、owner404、Origin／session與audit。官方MCP SDK的實際有預算資料與REST逐欄比對。

新頁面加入原UX smoke，另測四尺寸雙主題編輯／確認／三粒度報表／空狀態與390px年度分攤、修改、URL Enter／CSV、error/retry；舊unit/property/DB/OIDC/MCP/UI gates全部保留。

後續P2-3B已依ADR-0007 rev.2.1擴充v2備份並保留v1還原，另完成worker退避與週期卡片／時間改善。報表預設當月並將period寫入URL（只用於UI、不送API），圖表有data-chart-theme，預算格失焦以字串顯示千分位。整批仍需Claude驗收；不部署、不建立release tag。
