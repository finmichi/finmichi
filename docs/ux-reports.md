# P1.6 PR4：報表三頁

依 Workspace UX rev.1.2 §8.4／§12 與 Claude PR45 後續事項3。

- 直接使用目前帳本，移除報表舊功能分頁、帳本管理區塊與報表種類下拉；改用可鍵盤操作的三頁連結。深連結基準日仍會還原；收支與分類只讀取各自 URL allowlist 的期間／粒度／類別／業外／固定性，產生時同步 URL，支援重新載入與上一頁／下一頁，未知參數不送 API。
- 資產負債表：恆等式晶片、四項 KPI、桌面資產／負債兩欄 TreeTable、權益、外幣原幣餘額／歷史帳面值。KPI與手機卡片依§5省略整數的.00，淨值手機滿列；桌面表頭／首欄sticky。手機改為卡片；第一層預設展開，父科目小計粗體；自身／子樹資訊移到 title。本位幣原幣欄顯示「—」，外幣原幣餘額改為自然方向，帳面值沿用 API 的自然方向。
- 收支彙總：期間／粒度、既有1,000時段提示、營業／業外、合計、桌面表格／手機卡片與延遲載入長條圖。圖表先用 BigInt 等比正規化，僅最終座標轉 Number；標籤、提示、CSV保留原始精確金額。
- 分類統計：期間／kind／業外／固定性篩選、圓餅可用性原因、前十名帶號長條、樹狀金額與占比；保留 ADR-0005 邊界。金額不換行，報表容器不足 1,100px 時圓餅移到表格上方，葉科目不顯示自身行。
- 所有 ECharts palette、文字、座標、圖例、tooltip 背景均取正式 token，主題切換會 dispose／重建並維持篩選。
- 計算說明預設收合；期間欄位 Enter 可產生報表。
- 三頁沿用既有 report endpoint、CSV、core 與 SQL；沒有後端／migration／權限／audit／金額口徑變更。

驗證：`pnpm check`、`pnpm test:db`、`pnpm test:report-ui`、`pnpm test:ux-reports`；CI保留全部既有UI、OIDC與MCP檢查。本次本機 check：118 tests／21 files；DB：206 tests／26 files。UX矩陣包含3頁×4尺寸×2主題及16項修正案例，共40 cases／48 PNG，axe color-contrast／水平溢出／外部請求皆0；canvas文字實讀與當前token比對。另驗證 URL 還原、Enter、reload、back/forward、API allowlist，外幣資產800／負債100自然方向、本位幣原幣破折號、父科目粗體及18,000金額不換行／不裁切。截圖與JSON在`test-results/ux-reports/`並上傳CI artifact。

已知限制：P3重估、P2預算不在本批；路由全面lazy拆分留原PR45最終批次效能事項。報表含大量時段時以既有EdgeScroll捲動，沒有變更API上限。
