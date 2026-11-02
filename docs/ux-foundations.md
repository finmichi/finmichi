# P1.6 第一批：設計基礎與外殼

依 UX spec rev.1.1（6d38c17），本批僅完成 §11 PR1；後續 PR2–5 逐批等待 Claude 驗收，不開始 P2。

## 本批範圍

- `design/tokens.ts` 保存正式淺／深色值；`createLedgerTheme` 與 CSS variables 共用同一來源。主按鈕／Badge 的 filled、light、hover 明確使用正式 token，深色字使用 on-accent，避免 Mantine 自動混色造成對比回歸。
- 對比單元測試從 theme.other.tokens 重算正式矩陣與本批新增的側欄輸入／按鈕配對，最低 4.5。axe color-contrast 掃描真實頁面。
- 固定 @fontsource/ibm-plex-sans 5.3.0、ibm-plex-mono 5.3.0、noto-sans-tc 5.3.1，@tabler/icons-react 3.49.0；字體同源打包，TC 使用套件 unicode-range 子集。授權文字隨 public/font-licenses.txt 提供，不連 CDN。
- `design/format.ts` 只接收 decimal/date 字串，BigInt HALF_UP 做顯示 rounding；金額從不先轉 JS Number。支援千分位、U+2212、TWD compact／ISO 外幣、四位／十位匯率、兩位百分比、UTC 日期／星期。
- 900px 切換：228px 側欄／底部五格導覽與中央 FAB，主內容固定於剩餘高度，含 safe-area。提供 main landmark、跳至內容、aria-current、N／斜線快捷鍵與系統／淺／深色選擇。
- 共用帳本狀態，切換與主題偏好記在 localStorage；所有讀寫有 try/catch，儲存停用仍可操作。帳本清單永遠重新經既有 owner API 驗證，不信任儲存的 ID。
- 路由覆蓋規格清單、404、手機管理返回、瀏覽器 history。既有報表的 balance-sheet as_of 深連結初始化共用原 API，未改口徑。
- 單一 EdgeScroll，以 ResizeObserver、scroll 更新方向；隱藏捲軸、80% 點擊、原生鍵盤／wheel／touch、reduced-motion、箭頭 tabindex=-1。本批用於主內容與既有功能分頁，寬表格／抽屜／管理長清單由對應後續 PR 接用。

## 分批邊界

現有表單與功能內容保留，功能分頁接到新路由。總覽 KPI、明細新表格／卡片在 PR2；記帳抽屜與 dirty confirmation 在 PR3；報表新頁面／token 圖表在 PR4；管理中心內容搬移與所有 Toast／ConfirmDialog 在 PR5。因此目前首頁仍有既有快速記帳，尚未宣稱整套 UX 與原型內容一致。N／FAB 本批導向 /?entry=new 的現有記帳（含權杖／稽核頁的入口），後續 PR3 才替換成覆蓋層。

locked_until 已在既有 ledger 讀取回應中，本批只讀顯示；沒有新增或修改後端 endpoint、core service、migration、財務計算、權限或 audit。

## 驗證入口

`pnpm check`、`pnpm test:db`、`pnpm test:ux-foundations`。新 script 以 localhost 合成資料跑 16 路由 × 4 尺寸 × 2 主題，PNG 與 matrix/result JSON 在 test-results/ux-foundations，由 CI 上傳，另納入 workspace evidence。檢查 axe color-contrast、整頁水平溢出、899／900、箭頭到底消失、鍵盤、返回／404／深連結、偏好與 storage 拒絕。既有 7 個 UI script、OIDC runtime smoke、官方 MCP SDK DB smoke 繼續由 CI 執行。

回復方式：revert 本前端 PR；無 DB migration 或資料變更。第一批完成後停止，等待 Claude 驗收再做第二批。
