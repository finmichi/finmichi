# P2-1：關帳設定與解鎖

依 Workspace ADR-0010 rev.1 §1／§4／§5／§6、UX rev.1.2。此 PR 只實作 P2-1。

## API

`PATCH /api/ledgers/:ledger/lock`（session＋Origin），body 為嚴格物件：

```json
{ "locked_until": "2026-09-30" }
```

`locked_until` 必填，為真實 ISO date 或 JSON null；不得晚於 Asia/Taipei 今天。往後推直接允許；往前移或清除必須額外帶 `confirm_unlock: true`，否則 409 `unlock_confirmation_required`。字串 `"true"` 不接受。相同日期或 null→null 是冪等設定。回傳更新後 Ledger，含 `locked_until`。不認識的帳本／其他 owner 均 404；未登入 401，跨站 mutation 403。

獨立端點讓日期確認與名稱／本位幣修改分開；既有 `PATCH /api/ledgers/:ledger` 的嚴格 allowlist 不變。core `ledgerService.setLock` 透過既有 `mutation` 在單一 DB transaction 內取得 owner 帳本 `FOR UPDATE`、比較新舊日期、更新日期並寫成功 audit。未確認或其他失敗會保留原關帳值。其他交易寫入既有的同一帳本 row lock 因此和關帳設定串行化。

## 稽核與資料庫

新增 migration `0016_ledger_lock_audit.sql`，只擴充 audit action CHECK：`ledger.lock`／`ledger.unlock`。所有舊 migration、MCP tool／token_prefix constraints 保持不變。新的 audit action 同步 core allowlist 與 UI 中文篩選。只存既有 user/action/outcome/時間 metadata；不記新舊日期、確認旗標、帳本名稱、金額、摘要、cookie 或檔案內容。

往前移／清除採 `ledger.unlock`，往後推採 `ledger.lock`；相同非 null 設定採 lock、null→null 採 unlock。失敗也記 attempted action 的 error／denied outcome，未成功不記 success。

## UI

`/admin/ledgers` 每個帳本卡片含日期、儲存、清除；最大日期為臺北今天。清除先變更草稿，儲存才發送。往前移／清除先開共用 ConfirmDialog「解鎖關帳」，明示解鎖範圍；取消完全不發 PATCH，確認才送 `confirm_unlock: true`。成功 Toast、寫入中禁用、失敗 ErrorState 與重試均沿用共用元件；更新帳本清單後側欄／記帳的關帳提示跟著更新。保留既有帳本 CRUD、手機分組導覽／返回與 899／900 斷點。

## 自動化驗收

- `pnpm check`：日期 schema、真正 boolean、Asia/Taipei 午夜／跨年、解鎖條件的單元測試及所有既有測試。
- `pnpm test:db`：HTTP→DB 初次／往後／相同／往前／清除，未確認 409、有確認成功；future／無效輸入、owner／Origin／登入隔離；core inclusive create、update 舊／新日期、delete 與解鎖後恢復；並行更新依鎖後實際日期判斷；audit 全列無敏感內容且新 action 可篩選。
- 既有 audit 全 action 測試補上真實 setLock／unlock 呼叫，不能只 INSERT 假 audit。
- `pnpm test:ux-admin`：保留原 108 cases，新增 40 cases（四尺寸×雙主題×5狀態：lock-saved／unlock-confirmation／unlock-clear／lock-error／lock-saving）。每組都實際取消、確認、檢查 PATCH body／DB 值、模擬 503、重試、檢查 busy；axe contrast／無水平溢出／本地字型／焦點還原。共 148 截圖，納入原 CI artifact。
- CI 保留全部 unit/property/DB、OIDC/MCP 與所有 UI 回歸及 Trivy gate。

ADR §4 的 recurring occurrence `failed: period_locked` 狀態列依 §6 屬 P2-2（目前沒有 recurring rules／occurrences）；本 PR 先驗證未來共用交易 service 的 inclusive `period_locked` 拒絕。未開始週期、worker、預算／報表③、P2-2 或 P2-3。

## 維護與限制

只使用合成資料。升級時照原 migration runner 新增 0016，不回寫舊 migration；回復程式版本不需刪除此放寬 action CHECK 的 migration，也不會清除已設定的關帳日。完整備份／structure 還原及既有匯入行為不變，沒有新增或繞過 trigger／constraint。未部署 DS918+、未建立 tag、未直接或 force push main。
