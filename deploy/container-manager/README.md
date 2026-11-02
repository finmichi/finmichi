# Container Manager 圖形介面部署

本版 bundle 根目錄是 GUI 版；`ssh/` 只供 SSH 操作，**不要選錯 compose**。本輪在 dev 以合成資料驗證，沒有操作 NAS。以下已實測事項來自使用者在 DS918+ 的 D3 回報（2026-10-24）；尚未完成的 GUI 步驟明列待 D3 驗證。本版使用 FinMichi image、finmichi DB／角色與明確命名的 finmichi-db volume；舊的合成 volume 不會自動遷移或刪除。

## 1. 下載與核對

用已登入 GitHub 的瀏覽器，從核准的 Release 下載：

- `finmichi-deploy-<tag>.zip` 與 `.zip.sha256`（也提供相同內容的 `.tar.gz`）。
- 三個 `finmichi-image-<package>-<tag>.tar` 與各自的 `.tar.sha256`。
- `finmichi-deploy-<tag>.files.sha256`（逐檔校驗）。

以本機可信任的 SHA-256 校驗工具比對下載檔。任何一個不符就停止，重新下載，不啟動。Release 的 image ID 是 config digest；**Container Manager 映像清單不顯示 image ID（D3 已確認）**，因此 GUI 完整性以匯入前 tar 的 SHA-256 為準，不拿名稱當 ID 驗證。

## 2. 解壓縮與填寫設定

**File Station 可以解壓縮 zip（D3 已確認）**。上傳 zip 到選定的專案目錄，右鍵「解壓縮」。確認 `docker-compose.yaml`、`.env.example`、`README.md`、兩個備份腳本在同一層；`ssh/` 是另一套部署方式。

以文字編輯器將 `.env.example` 另存 `.env`，和 `docker-compose.yaml` 放同一資料夾。以 UTF-8 無 BOM 儲存，**保留第一行註解**。設定檔只讓 administrators 讀取；不得貼到對話、截圖或 Git。

- `IMAGE_TAG`：三個 image 共同的核准 tag。
- `NAS_LAN_IP`：NAS 區網 IP，供 app 的 `extra_hosts` 解析 SSO。app 啟動就會做 OIDC discovery；連不到 issuer 會啟動失敗。
- `PUBLIC_URL`、`OIDC_ISSUER`、client ID：依使用者已驗證的 SSO 設定。
- `OIDC_CLIENT_SECRET`：保留範本的單引號；不要將未加引號的 `$` 放進值。
- `POSTGRES_PASSWORD`：**只能使用英文字母與數字（不得含 `$` 或任何符號），32 字元以上。第一次啟動後不得直接修改。**
- 首次 `ALLOWED_SUBJECTS` 可用 `placeholder-not-a-user`，暫開 `OIDC_SUBJECT_DISCOVERY=true`；確認身分後立刻關閉。
- 初次合成驗證先保持 `MARKET_DATA_ENABLED=false`。

部署前確認每一個 DSM 反向代理項目都套用有效的 wildcard 憑證並開啟 HSTS。D3 曾發現網站項目仍套用已過期的單一網域憑證；不要只檢查 SSO 那一項。app 綁定 `127.0.0.1:8080`，由 DSM 終結 TLS。

## 3. 匯入映像

**Container Manager → 映像 → 從檔案新增**，逐一匯入已核對 SHA 的三個 tar。確認名稱與共同 tag：`ghcr.io/finmichi/finmichi`、`finmichi-worker`、`finmichi-postgres`。

本版 `pull_policy: never`；image 不存在時必須失敗，不能自動下載。離線載入／啟動已在 Docker 24.0.2 獨立 daemon 驗證；不等同所有 DSM GUI 操作已驗收。

## 4. 建立專案

**Container Manager → 專案 → 新增**，名稱可自訂（使用者採 `finmichi`）；選擇解壓目錄與 `docker-compose.yaml`。這個檔名已由 D3 實測可用；`compose.yaml` 未實測。不要勾選 Web Station 入口。

啟動後確認 app、worker、postgres healthy。DB 沒有對外 port，資料在固定名稱 `finmichi-db` 的 named volume；**finmichi-db 絕對不可以刪除**。本版沿用 daemon 預設 log driver，日誌大小／保留由 DSM 管理；GUI 版不指定 `logging` 或核心不支援的 `pids_limit`。app／worker 停止等待 30 秒、postgres 60 秒。

## 5. 確認 sub 與套用 .env

1. 私密視窗登入，在一次性確認頁取得自己的 sub；只保存在 NAS 的設定檔。
2. 修改 `.env` 的 `ALLOWED_SUBJECTS`，把 `OIDC_SUBJECT_DISCOVERY=false`。
3. **Container Manager → 專案 → 動作 → 建置**會讓 `.env` 修改生效（D3 已實測）。確認 healthy 後用新的私密視窗登入。

單純 Docker `stop/start/restart` 不會重讀環境變數，不應代替建置。dev 合成 smoke 另驗證僅修改上述兩欄並重建時只有 app 變更，postgres volume 與資料保留。

## 6. 備份與演練（GUI 任務排程待 D3 實測）

建置完成後，先等 postgres 變成 **healthy**、首次初始化完成，再執行第一次備份。看到容器 running 不代表初始化已完成；健康檢查走 TCP `127.0.0.1`。

**控制台 → 任務排程器 → 新增 → 排程的任務 → 使用者定義的指令碼**，選 root。每日備份指令（依目錄與專案名稱調整）：

```sh
export PATH=/usr/local/bin:$PATH
POSTGRES_CONTAINER=finmichi-postgres-1 BACKUP_DIR=/volume1/backup/finmichi KEEP=30 sh /volume1/docker/finmichi/nas-backup.sh
```

另一個預設停用、需手動執行的演練任務：

```sh
set -eu
export PATH=/usr/local/bin:$PATH
backup_dir=/volume1/backup/finmichi
latest=$(find "$backup_dir" -maxdepth 1 -type f -name 'finmichi-????????-??????.dump' | LC_ALL=C sort | tail -n 1)
[ -n "$latest" ] || { echo '找不到備份'; exit 1; }
POSTGRES_CONTAINER=finmichi-postgres-1 sh /volume1/docker/finmichi/nas-restore-drill.sh "$latest"
```

兩個任務都必須帶 `POSTGRES_CONTAINER=<專案名稱>-postgres-1`。演練只還原到獨立 `finmichi_drill`，檢查後刪除，不覆蓋現有帳本。GUI 的排程執行及重開機恢復仍待 D3 實測。

## 7. 升版／Rollback（完整 GUI 流程待 D3 實測）

先執行備份與還原演練。下載核對新 bundle／三個 tar，解壓更新部署檔但**保留自己的 `.env`**；匯入新映像，修改 `IMAGE_TAG`，用「專案 → 建置」生效。保留舊版 tar 與備份。若 `BACKUP_DIR` 放在專案資料夾內（例如 `/volume1/docker/finmichi/backup`），替換部署檔案時**不可以刪除整個專案資料夾**；只覆換部署檔，保留 `.env`、備份目錄與私人檔案。

Rollback 只能在核准窗口選回已匯入、與目前 schema 相容的 tag。回退 image 不會回退 DB migration；不相容時停止，另行規劃還原，不可刪除 volume 嘗試回復。

### 舊 volume 的處理

Container Manager 24 沒有 volume 管理畫面。**可以保留舊 volume 不處理**；「清除」專案不等於刪除 named volume。**`finmichi-db` 絕對不可以刪除**，也不得使用 `docker volume prune` 或 `compose down -v` 清理本專案。

只有已確認不再使用、資料可丟棄且不是 `finmichi-db` 的舊合成 volume，才可由管理者使用 SSH 逐一確認後執行下列指令（不是 GUI 的必要步驟）：

```sh
# 僅供人工確認過的舊合成 volume；不要填 finmichi-db。
docker volume rm '<已確認可刪除的舊合成-volume名稱>'
```

若不能確定用途、是否有資料或備份，保留不刪。不要刪除整個專案目錄來清 volume。

### 外幣帳戶說明

資產負債表的「帳面」使用交易當時匯率。E-Money 的部分外幣分錄沒有匯率紀錄（`foreign_leg_rate_one`），帳面上的台幣金額可能失真；應以「市值」欄（臺銀匯率重估）為準，並確認行情日期與是否顯示無行情。無行情時的帳面替代值不是重估結果。本次只補文件，不改計算。

## 8. 疑難排解

| 現象                                     | 處理                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error while interpolating services.<x>` | 確認 `.env` 同資料夾、檔名正確、第一行註解、無 BOM、值沒有未加引號的 `$`；若出現 `NAS_ROOT`，通常選錯 `ssh/` 版 compose。                                                                                                                                                                           |
| `"XXX" variable is not set`              | 值中的 `$` 被 Compose 當成變數；OIDC secret 要用單引號，DB 密碼只用英數字。                                                                                                                                                                                                                         |
| `28P01`／`db_auth_failed`                | volume 已用舊密碼初始化。恢復原設定，**改 .env 不會改 DB 密碼**。Container Manager「清除」不會刪除 named volume。只有已確認完全空白、可丟棄的合成 DB，才可依「舊 volume 的處理」另行規劃；finmichi-db 絕對不可以刪除；有資料時絕不可這樣做。正式改密碼程序需另行設計與核准，見 SSH RUNBOOK 的限制。 |
| 日誌空白                                 | GUI compose 不應含 `logging: json-file`；改用 DSM 預設 driver，再建置。                                                                                                                                                                                                                             |
| `db_unreachable`                         | 檢查 DB 健康、網路與名稱；不輸出連線字串。                                                                                                                                                                                                                                                          |
| `migration_pending`                      | 檢查三個 image tag 是否一致，保留錯誤類別交由維護者處理。                                                                                                                                                                                                                                           |
| `config_invalid`                         | 檢查必要變數、檔案與格式；不要把設定值貼到對話。                                                                                                                                                                                                                                                    |
| app 未啟動                               | 檢查 issuer discovery、憑證、client 設定、NAS_LAN_IP。不得關閉 TLS 驗證。                                                                                                                                                                                                                           |

### 備份任務錯誤代碼

備份失敗會以非 0 結束，並輸出 `backup_error=<code>`，不顯示原始 DB 診斷或連線資訊。就緒判斷走 TCP `127.0.0.1`，避免首次初始化的暫時 socket 伺服器誤判；`BACKUP_WAIT_SECONDS` 預設 60 秒，0 代表只探測一次。

| 代碼                    | 處理方式                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `container_not_running` | 確認 `POSTGRES_CONTAINER` 名稱與 Container Manager 中的 PostgreSQL 容器一致，且容器正在執行。                                                                                                     |
| `db_not_ready`          | PostgreSQL 可能仍在首次初始化或重啟。等待健康狀態恢復後重試；必要時增加 `BACKUP_WAIT_SECONDS`。                                                                                                   |
| `db_auth_failed`        | 確認 DB 角色與認證設定；不要貼出密碼。修改 `.env` 不會變更已初始化 DB 的密碼。                                                                                                                    |
| `dir_not_writable`      | 確認 `BACKUP_DIR` 存在或可建立，排程執行身分具有寫入權限，磁碟非唯讀。                                                                                                                            |
| `disk_full`             | 檢查剩餘空間與配額；先移走已確認保留妥當的檔案，勿刪除唯一備份。                                                                                                                                  |
| `backup_locked`         | 先確認沒有另一個備份任務執行。若前次確已中止，暫停排程並確認沒有備份程序後，才在 File Station 移除 `BACKUP_DIR/.finmichi-backup.lock`（必要時顯示隱藏項目），再恢復排程。不可在備份進行中移除鎖。 |
| `config_invalid`        | `KEEP` 必須是 1–2147483647 的整數，`BACKUP_WAIT_SECONDS` 必須是 0–2147483647 的整數；不可含空白、符號或小數。                                                                                     |
| `dump_failed`           | 其他傾印、驗證或檔案處理失敗；確認 Docker 可用、DB 存在與工具相容。提供安全錯誤代碼與版本供維護者調查，不貼出正式設定。                                                                           |

不得將正式密碼、cookie、token、財務資料放進日誌或 evidence。

## v0.2.2 升級設定

升級前先備份。保留私人 `.env`，但必須新增 `OIDC_HAIRPIN_HOST`，填入 `OIDC_ISSUER` 的主機名稱（例如 issuer 為 `https://sso.example.com/webman/sso`，填 `sso.example.com`），不可包含協定、port 或路徑。app 的 `extra_hosts` 會把此名稱解析到 `NAS_LAN_IP`；worker 不需要此設定。沒有設定時 Compose 直接回報 `OIDC_HAIRPIN_HOST required`，不會靜默啟動。app 啟動即做 OIDC discovery；此值不改變 TLS 憑證或 issuer 驗證。

替換 bundle 的 compose 與操作文件後，依原流程重建專案；不要覆蓋自己的密碼、allowed subjects、volume 或備份。此 PR 沒有 migration，既有帳務資料不變。文件的 `example.com`、文件用 IP 與 `dev`／`nas` 是範例，不能直接連到任何使用者部署；私人部署清單另存 Workspace。
