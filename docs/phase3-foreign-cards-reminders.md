# P3-5 外幣信用卡與提醒中心

依 Workspace ADR-0012 rev.1.11 §4／4.1／5／5.1／8。只用合成資料；不部署、不建立 tag。

## 外幣信用卡

- 帳單、已繳、未繳、額度使用率維持原幣 `amount`；不加總不同幣別的卡片。
- 卡片繳款帳戶可為本位幣或同幣別；貸款仍限本位幣。新 migration 0027 更新 service 對應的 DB trigger，舊 migration 不變。
- `cardQuote` 以最近可用臺銀即期賣出（跨幣別同日分子 sell／分母 buy）、帳本匯率、無行情的順序查找，HALF_UP 4 位；原幣乘匯率後 HALF_UP 2 位。全程 BigInt。
- 同幣別用轉帳模式；跨幣別用進階模式，顯示來源、日期、預估匯率及可修改提示。無匯率時，卡片原幣金額仍在，本位幣金額留空。
- `cardAllocations` 共用今日欠款原幣封頂邏輯。資金預估再換成本位幣，僅對選定本位幣付款帳戶投影；無匯率回 `fx_rate_missing` warnings，不預填 1:1。

## 提醒與 API

`reminderService` 共用於 REST 與 MCP。GET 使用 PostgreSQL repeatable-read/read-only transaction，不建立預設設定列、不更新草稿或行情。只有設定與已讀 API 寫入。

- GET `/api/ledgers/:ledger/reminders`：六類即時計算清單、未讀數。
- GET／PUT `/api/ledgers/:ledger/reminders/settings`：嚴格 schema，預設值與範圍依 ADR；PUT audit `reminder.settings_update`，不記設定內容。
- POST `/api/ledgers/:ledger/reminders/read`：`items` 1–200 或 `all:true`；比對目前 fingerprint，舊 fingerprint 略過；upsert 後同帳本保留最新 1,000 列。無 audit。
- `key` 與 SHA-256 canonical JSON fingerprint 按 ADR 欄位建構；排序為逾期、日期、類型、key。同一內容已讀，金額／日期／payload 變動則重新未讀。
- 回應不含 occurrence template、draft payload、摘要或發票內容，避免提醒 detail 間接洩漏 MCP mask_text 欄位；MCP 沿用既有 scope、帳本範圍、輸出上限與 audit。
- `/admin/reminders` 設定頁、頂部鈴鐺（含數字 aria-label）、全部已讀、逐筆已讀後跳頁、總覽前 3 筆。讀取失敗可重試；四尺寸雙主題矩陣含空／載入／錯誤。

## 備份 v7

full／structure 都包含 `reminder_settings`；僅 full 包含 `reminder_reads`。key 中的定存、科目、occurrence UUID 使用對照表換新；market key 保留；無對照列略過（包括不進備份的 AI 草稿）。舊 v1–v6 以原 checksum 驗證後補空表。外幣卡備份採新幣別規則。

fingerprint 本身是原始內容 hash，還原時保留；若 occurrence template 的參照 UUID 改變，新的 canonical JSON 與 hash 也改變，因此該週期提醒重新未讀。已讀定存等不含 UUID 的內容不受影響。

## 驗證對照

| ADR 要求                                              | 自動化                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| 即期賣出／同日交叉／ledger fallback／缺行情／HALF_UP  | `card-fx.test.ts`、`finance-payments.test.ts`                            |
| 原幣帳單、限制、封頂後換算、缺匯率 warnings、零寫入   | `foreign-cards-reminders.db.test.ts`；原 `cash-forecast.db.test.ts` 回歸 |
| 六類範圍、T＋days、逾期排除／包含、交易日日曆、排序   | `foreign-cards-reminders.db.test.ts`                                     |
| canonical hash、設定範圍、未知輸入                    | `reminder.test.ts`、HTTP DB 測試                                         |
| stale fingerprint、all、清理、內容變更、owner／Origin | `foreign-cards-reminders.db.test.ts`                                     |
| 備份 v7 full／structure、舊版本、MCP REST 一致與遮罩  | DB tests、`restores.test.ts`、官方 SDK client                            |
| UI 付款預填／缺匯率／鈴鐺／設定／前3／99+／定存建議   | `pnpm test:ux-reminders`，96 PNG／4尺寸×2主題                            |

既有 OIDC、worker、完整 DB、unit/property 與 UI suites 仍由 CI 執行，沒有停用任何檢查。確切實測結果與 CI run 存 Workspace evidence；尚未通過的項目不能僅憑此對照表宣稱通過。
