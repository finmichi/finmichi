# P1.6 PR5：管理中心與全站狀態

依 UX rev.1.2 §8.5／§9／§12，收尾 PR45／46／49 後續事項。只改前端、驗收 script、文件與 CI 的新 UI 步驟；不修改 server/core/DB、金額口徑、權限、稽核或寫入 API。

- 桌面 200px 次導覽，手機分組選單／子頁返回；清單數量含封存，稽核／匯入紀錄的 `25+` 明確表示仍有下一頁，非完整總數。已刪除舊 Catalogs/Tabs 與 dead CSS。
- 帳本新增／改名／切換／空帳本刪除；`locked_until` 唯讀，null 顯示未關帳，不提供設定／解鎖。科目 TreeTable、搜尋、封存切換與抽屜編輯；收付人／專案／摘要同樣支援搜尋、CRUD、封存與抽屜。
- CSV 精靈步驟條保留原本 preview/signature/skip-invalid/duplicate 閘門，確認後才批次寫入。E-Money 只顯示 CLI 說明與既有唯讀 audit 的本人匯入操作紀錄（所有帳本），不新增 MDB 上傳，也不以操作紀錄替代來源檔的核對報告。
- JSON 備份、full/structure 預覽還原與 CSV 出口保留。MCP 權杖只在一次性 Modal 顯示，提供複製／隱藏；不存瀏覽器，截圖不包含完整權杖；撤銷使用共用確認框。稽核用桌面 table／手機卡片、AND 篩選、cursor 更多與回頂端。系統資訊從既有 health/me/transactions/ledger 讀版本、身分、本位幣、時區、最後交易日期。
- EmptyState／LoadingState（首次骨架，更新細進度條）／ErrorState＋重試／2.8秒 Toast／ConfirmDialog 共用。交易刪除、dirty guard、還原、匯入、權杖撤銷與名稱刪除沿用同一頁內確認；失敗返回原表單顯示錯誤。Drawer/Modal 採 Mantine focus trap／return focus，中文取消／確認／close labels。
- 明細手機標題將筆數與合計分兩行，標籤＋金額不拆開；桌面無收付人／專案時合為一個「—」。資產負債表含外幣科目時加「外幣以歷史帳面值計。」
- 總覽／查詢／報表／管理／記帳，以及各管理子頁 route lazy load；ECharts/zrender 分開的 vendor 均由圖表延遲載入。完整各 JS chunk 的 raw／gzip bytes 見 evidence `bundles.json`，沒有提高 Vite warning limit。

## §12 驗收對照

| 項目      | 驗證入口                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 截圖    | foundation/daily/entry/reports 原矩陣保留；ux-admin 的11頁×4尺寸×2主題、抽屜／確認框16組，另含4種狀態。最終 CI PNG 與 matrix.json 保存 Workspace |
| 2 斷點    | foundation 驗899／900；新矩陣驗200px次導覽、手機分組／返回                                                                                       |
| 3 捲動    | foundation 保留水平 EdgeScroll 箭頭可點／到底消失（移至交易類別晶片）、垂直滾輪／鍵盤／到底；管理清單和抽屜重用 EdgeScroll                       |
| 4 格式    | 原 format/money/property 單元測試及 report/transaction UI；此次未修改金額運算                                                                    |
| 5 對比    | token contrast unit＋全部 UI 矩陣 axe color-contrast；收入／支出／結果保留文字標籤                                                               |
| 6 導覽    | 所有管理頁深連結／手機返回、報表 URL allowlist/reload/back-forward 保留                                                                          |
| 7 記帳    | entry smoke 全部保留：就地新增／自動選取、Esc／遮罩、dirty guard、編輯／save-next                                                                |
| 8 管理    | 新 UI→HTTP→DB 帳本／科目／名稱CRUD、父／旗標／封存／搜尋；既有 CSV/backup/PAT/audit smoke 全保留                                                 |
| 9 狀態    | 以合成空帳本、延遲及503網路探針驗骨架／空／錯誤重試／Toast；確認框8組，成功通知自動消失                                                          |
| 10 無障礙 | editor autofocus、Esc、dialog取消return focus，foundation鍵盤／skip-link，手機44px全域及管理按鈕                                                 |
| 11 效能   | fresh browser記錄首頁與訪問管理後 JS requests；首頁不載 ECharts／PAT／科目／記帳 route，woff2分段、外部請求0                                     |
| 12 回歸   | pnpm check、DB整合（含官方MCP SDK）、OIDC容器與所有舊UI smoke 全部保留在 CI                                                                      |

本文件為實作與測試定位；通過數量、精確 head、CI checkout 與最終 artifact 以 Workspace evidence 為準，不替代 Claude 的12項人工作業驗收。P2／NAS／release 不在本批。

## Production JS chunks

本機 production build；kB = 1,000 bytes，gzip 使用 level 6。此表使用 logical chunk 名稱；完整雜湊檔名與精確 bytes 以最終 CI artifact 的 `ux-admin/bundles.json` 為準。

| Chunk                 | raw kB | gzip kB |
| --------------------- | -----: | ------: |
| `Checkbox.js`         |   6.36 |    2.40 |
| `Drawer.js`           |   5.04 |    1.83 |
| `FileInput.js`        |   2.17 |    1.06 |
| `SegmentedControl.js` |   6.18 |    2.55 |
| `TextInput.js`        |   0.26 |    0.21 |
| `Textarea.js`         |   4.19 |    1.91 |
| `admin.js`            |   4.57 |    2.08 |
| `admin-editor.js`     |   0.51 |    0.38 |
| `audit-log.js`        |   4.53 |    2.17 |
| `back-to-top.js`      |   0.60 |    0.41 |
| `backup-page.js`      |   9.97 |    4.33 |
| `chart-renderer.js`   | 175.69 |   58.43 |
| `data-revision.js`    |   1.27 |    0.70 |
| `echarts-vendor.js`   | 353.40 |  122.03 |
| `entry-overlay.js`    |  20.23 |    7.97 |
| `format.js`           |   1.18 |    0.73 |
| `get-env.js`          |   0.09 |    0.11 |
| `import-page.js`      |  10.09 |    4.78 |
| `index.js`            | 438.27 |  138.42 |
| `iso.js`              |  93.84 |   26.57 |
| `items.js`            |   5.01 |    2.39 |
| `ledgers.js`          |   2.92 |    1.48 |
| `named-records.js`    |   3.94 |    1.88 |
| `overview.js`         |   7.19 |    2.83 |
| `pats.js`             |  35.49 |   13.61 |
| `query.js`            |  14.15 |    5.52 |
| `report-charts.js`    |   6.38 |    2.65 |
| `report-common.js`    |   2.66 |    1.30 |
| `reports.js`          |  14.80 |    5.18 |
| `system-page.js`      |   1.13 |    0.65 |
| `transaction-list.js` |   5.77 |    2.25 |
