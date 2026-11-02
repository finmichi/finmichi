<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# 刪除帳本與原廠重置

這個動作無法復原。請先完成 NAS 任務 A（資料庫備份），再依畫面逐本下載 JSON 並確認檔案可讀取。JSON 不包含 AI 草稿、PAT、登入狀態與排程執行狀態，這些資料無法由 JSON 還原；JSON 還原一律建立新帳本。

- 管理中心 → 帳本與關帳：每本帳本提供「刪除帳本與全部資料」。關帳日會顯示，但不阻擋整本刪除。
- 管理中心 → 系統資訊：原廠重置刪除目前使用者所有帳本與 PAT，保留使用者、目前 session、audit logs 與全站行情／匯率。只有 operator 明確設定 `FINMICHI_ALLOW_FACTORY_RESET=true` 才顯示；所有 compose／env 範例預設 false。
- 請先按「重新登入驗證身分」。OIDC 使用 `prompt=login`、PKCE 與 nonce；成功後回到原頁面，再開啟操作。5 分鐘內有效，切換帳號會拒絕。重新登入會換 session，先前的刪除授權隨舊 session 失效。
- 預覽列出每張表的筆數及關帳日，發出使用者、session、mode、帳本集合綁定的 10 分鐘 `backup_token`，DB 僅存 SHA-256。每位使用者只有一份有效預覽，新預覽會取代舊預覽。
- 逐本完成下載，再輸入完整帳本名稱或 `RESET`，勾選備份確認。授權及重新驗證均有效才可按 danger 確認。瀏覽器能確認回應完整接收並發起下載，無法證明儲存媒體已落盤，因此仍需使用者確認檔案可讀。

## API 與安全邊界

| 操作           | API                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------- |
| 帳本預覽／執行 | `POST /api/ledgers/:ledger/purge-preview`、`POST /api/ledgers/:ledger/purge`             |
| 重置預覽／執行 | `POST /api/factory-reset-preview`、`POST /api/factory-reset`                             |
| 本次操作的備份 | `POST /api/ledgers/:ledger/backup.json`，body 為 `{ "backup_token": "<PREVIEW_TOKEN>" }` |

執行 body 為 `backup_token` 與 `confirmation`。token 不放 URL、localStorage 或 log。原有 `GET backup.json` 完全保留，但不會核發刪除資格。伺服器只認該次授權產生的備份紀錄；跳過前端、偽造完成旗標都無法執行。所有新增 API 維持 session、Origin、owner 404 邊界，PAT-only 401、帶 cookie 及 Bearer 仍拒絕；MCP 沒有對應 tool。

伺服器以精確字串的資料列快照雜湊核對備份前後狀態，不透過 JS 浮點 JSON 解析帳務數值。資料改動或帳本集合變更會要求重新預覽／備份。JSON 未涵蓋的草稿與 worker 狀態也在快照中。只刪除明確預覽過的帳本 ID，不以廣泛 owner DELETE 吞掉同時新建、尚未備份的帳本。

刪除依 FK 順序在單一 transaction 中完成；不停用 constraint／trigger，不改寫已合併 migration。最後的稽核寫入也屬同一個 transaction，失敗會連資料及授權消耗一起回滾。每人跨 purge／reset 共用 10 分鐘一次限制，以保留的成功 audit 為準，user row lock 防止跨程序競爭。時限在取得鎖後及刪除前以即時 DB 時鐘再確認，避免 transaction-start `now()` 凍結時刻。

`ledger.purge`／`account.factory_reset` 的 audit 只有資料表筆數與耗時，不保存 token、cookie、金額、摘要、檔案內容。資料表分類清單會與實際 public base tables 比對，遇到未分類的新表直接停止；新增 migration 時必須同步更新分類與全表 fixture。

## 錯誤與恢復

| code                                             | 處理                                     |
| ------------------------------------------------ | ---------------------------------------- |
| `reauth_required`                                | 重新登入後重新開始                       |
| `backup_token_required` / `backup_token_invalid` | 重新預覽及逐本下載                       |
| `backup_required`                                | 完成所有本次授權的備份                   |
| `preview_changed`                                | 資料已變更，重新預覽及下載               |
| `confirmation_mismatch`                          | 逐字輸入指定文字                         |
| `reset_rate_limited`                             | 10 分鐘後重試                            |
| `deletion_schema_incomplete`                     | 停止操作，維護者須補齊 schema 分類與測試 |

`0030_data_reset.sql` 僅新增 session 重新驗證欄位、短期授權表及 audit metadata／action CHECK；不改帳務數字、既有 migration 或 JSON v9 格式。既有 session 的驗證欄位為 null／false，必須明確重新登入。升級失敗由 migration transaction 回滾；若要切回舊 app，保留這些新增欄位／表，不能改 migration checksum。刪除成功無 DB undo，請用事前 JSON 建立新帳本或依備份 runbook 做隔離還原。
