# Phase 1.2：帳本 CRUD

本 PR 提供登入後的帳本管理畫面與 API。只使用合成資料驗證，不包含交易功能或部署。

| Method               | Path                   | 行為                   |
| -------------------- | ---------------------- | ---------------------- |
| GET / POST           | `/api/ledgers`         | 列出本人帳本／新增     |
| GET / PATCH / DELETE | `/api/ledgers/:ledger` | 讀取／修改／刪除空帳本 |

新增接受 `name`（trim、1–200 字）、`base_currency`（3 位大寫、預設 TWD）；PATCH 至少一個欄位。strict schema 拒絕 `owner_id`、`locked_until` 等未知欄位。owner 由 DB session 決定。

權限與 mutation audit 在 core service，REST/MCP 可共用；不屬於本人或不存在的 ID 同為 404。錯誤只回安全 code：`invalid_input` 400、`not_found` 404、`duplicate_name`／`in_use`／`ledger_not_empty` 409。未登入 401；寫入 Origin 不符 403。audit 只記 user/action/outcome，不記名稱或帳務內容。

保守限制：只有空帳本能刪除或改本位幣。檢查 items、payees、projects、memo_templates、transactions、exchange_rates、import_jobs；已有任一資料即 409，避免 cascade 刪除與既有金額解讀改變。ledger row lock 與子表 FK lock 序列化並行修改。已有資料仍能改名。

UI 可新增、選擇、管理、改名、改空帳本幣別，刪除需二次確認；失敗保留表單。既有資料庫與已合併 migration 不變。

驗證：`pnpm check` 通過，36 unit tests；`pnpm test:db` 通過，54 tests（43 既有＋11 帳本 API/core/並行測試）。API 測試使用真實 DB session 與本機合成 discovery fixture，不繞過 production auth hook。production dependency audit HIGH/CRITICAL 0。

獨立 Chrome + self-signed 本機 TLS fixture 實際操作新增、改名、空帳本改幣別、刪除均通過。390px 無水平溢出；截圖 evidence `ledger-ui-390.png`。UI fixture 的 session 由正式 session service 產生，沒有寫入 token 檔案；OIDC redirect 流程另由既有 compose CI smoke 驗證。

Property test PR 為獨立主題，本分支不包含它。其餘基本資料 CRUD 由後續 PR 提供；沒有 release tag 或 NAS 變更。
