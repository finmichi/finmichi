# DS918+ Runbook（D0 準備）

本文件供使用者於核准的 D1–D6 階段操作。D0 僅在 dev 使用合成資料驗證；沒有部署、打 tag 或取得正式 secrets。P3 已完成，第一個正式版本為 v0.1.0；打 tag 前小 PR 須先經 Claude PASS 且使用者同意 merge，才可執行已預先核准的 D1 發布與 dev 合成 staging 回歸。D1 不含 NAS 部署。所有正式密碼、client secret、GHCR token 只保存在 NAS 與密碼管理器。不要貼到聊天、截圖或 evidence。

## 1. 前置與權限（D2）

使用者準備 Docker Compose v2、Container Manager、足夠磁碟與已核准的三個 private image。`NAS_ROOT`、`BACKUP_DIR` 是 NAS 上的絕對路徑，填入使用者選定目錄；以下尖括號都是占位值。部署不需要 private repo checkout 或 git 認證。先從 GitHub 已登入的瀏覽器下載核准版本 Release 的 `finmichi-deploy-<tag>.tar.gz` 與同名 `.tar.gz.sha256` 兩個 asset，傳到 NAS 的暫存下載目錄；兩者都是 GitHub Release asset，三個 container image 則在 GHCR。關閉 shell tracing（`set +x`）。不要從 dev 複製 dev secrets。

```sh
export NAS_ROOT='<NAS_PROJECT_DIRECTORY>'
export BACKUP_DIR='<NAS_BACKUP_DIRECTORY>'
export IMAGE_TAG='<APPROVED_RELEASE_TAG>'
export PATH=/usr/local/bin:$PATH
export BUNDLE_DOWNLOAD_DIRECTORY='<NAS_DOWNLOAD_DIRECTORY>'
BUNDLE="finmichi-deploy-$IMAGE_TAG.tar.gz"
cd "$BUNDLE_DOWNLOAD_DIRECTORY"
# 不通過就停止，不可解壓或啟動；重新從核准的 private Release 取得兩個 asset。
sha256sum -c "$BUNDLE.sha256" || exit 1
mkdir -p "$NAS_ROOT/deploy"
tar -xzf "$BUNDLE" -C "$NAS_ROOT/deploy"
# 後續相對路徑 deploy/... 均從 NAS_ROOT 執行。
cd "$NAS_ROOT"
# 使用只有 read:packages、有期限且可讀三個 package 的專用 token；從密碼管理器輸入。
# 在 NAS 互動終端輸入 token；不把 token 放在命令參數、歷史或檔案。
stty -echo
IFS= read -r GHCR_TOKEN
stty echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username '<GITHUB_LOGIN>' --password-stdin
unset GHCR_TOKEN
# 自動化時可由密碼管理器串接 docker login --password-stdin；禁止 echo 明文 token。
for image in finmichi finmichi-worker finmichi-postgres; do
  docker pull "ghcr.io/finmichi/$image:$IMAGE_TAG"
done
PG_UID=$(docker run --rm --entrypoint id "ghcr.io/finmichi/finmichi-postgres:$IMAGE_TAG" -u postgres)
PG_GID=$(docker run --rm --entrypoint id "ghcr.io/finmichi/finmichi-postgres:$IMAGE_TAG" -g postgres)
sudo mkdir -p "$NAS_ROOT/postgres" "$NAS_ROOT/secrets" "$BACKUP_DIR"
sudo chmod 700 "$NAS_ROOT/secrets" "$BACKUP_DIR"
sudo chown "$PG_UID:$PG_GID" "$NAS_ROOT/postgres"
sudo chmod 700 "$NAS_ROOT/postgres"
cp deploy/ssh/.env.nas.example deploy/ssh/.env.nas
chmod 600 deploy/ssh/.env.nas
```

以 DSM SSH 調整一次資料目錄擁有者；不要遞迴 chown 其他服務。查到的 UID/GID 才是依據，不能把 DSM 帳號 UID 當成容器 postgres UID。

用 NAS 本機編輯器／密碼管理器建立以下檔案，目錄維持 root:root 700；Docker daemon 只個別 bind mount 檔案。app/worker 為 UID 65532，postgres 用上面查到的 UID；檔案 mode 400、擁有者如下。不要掛整個 secrets 目錄、不要加 `:Z`。

| 檔案                | 擁有者        | 內容（不要記錄內容）                                                   |
| ------------------- | ------------- | ---------------------------------------------------------------------- |
| database-url        | 65532:65532   | postgres URL，user/database finmichi，host postgres；密碼須 URL encode |
| worker-database-url | 65532:65532   | 相同 DB 的連線 URL，獨立檔案                                           |
| postgres-password   | PG_UID:PG_GID | 與 URL 相同的原始密碼                                                  |
| oidc-client-secret  | 65532:65532   | confidential client secret；public client 使用空檔                     |

```sh
sudo chown 65532:65532 "$NAS_ROOT/secrets/database-url" "$NAS_ROOT/secrets/worker-database-url" "$NAS_ROOT/secrets/oidc-client-secret"
sudo chown "$PG_UID:$PG_GID" "$NAS_ROOT/secrets/postgres-password"
sudo chmod 400 "$NAS_ROOT/secrets/"*
```

填寫 `.env.nas`：`IMAGE_TAG` 三服務共用；`PUBLIC_URL=https://money.example.com`；`OIDC_ISSUER=https://sso.example.com/webman/sso`（範例，須以自己的 discovery 驗證）；client ID/allowed subjects 由使用者填入。`NAS_LAN_IP` 填 NAS 的內網 IP，僅存 NAS 本機，不提交。app 的必要 `extra_hosts` 將 `OIDC_HAIRPIN_HOST` 指向該 IP；worker 不需要。`MARKET_DATA_ENABLED=false`、`OIDC_SUBJECT_DISCOVERY=false` 預設關閉。`MCP_DRAFT_MAX_BASE_AMOUNT` 預設 100000，可依政策調整，最高 10000000。只填路徑／非秘密設定，client secret 仍用檔案。

## 2. DSM 與 OIDC 清單（D2 相容性已確認，D3 仍須驗證登入）

- SSO Server 伺服器 URL：`https://sso.example.com`。建立 OIDC 應用；redirect URI **`https://money.example.com/auth/callback`**。啟用 Authorization Code + PKCE。
- SSO 設定範例的 issuer 為 `https://sso.example.com/webman/sso`；供應者須支援 PKCE S256 及 client_secret_basic／client_secret_post。`OIDC_ISSUER` 必須等於 discovery 文件的 issuer，並使用 HTTPS。正式 app 不接受開發 mock transport。
- **app 啟動時就會做 OIDC discovery；連不到 issuer 時會啟動失敗。** 此環境不支援 NAT hairpin，因此 `compose.nas.yaml` 已直接套用必要的 app `extra_hosts`，不可漏填 `NAS_LAN_IP`。這只改容器內解析，不改 TLS 主機名稱與憑證驗證。內網瀏覽器也須確認能開啟 money／sso 網域。
- NAS 上先執行下面的無秘密檢查（把 `<NAS_LAN_IP>` 換成 NAS 內網 IP）。應取得 JSON，issuer 與上列一致；不能用 `-k` 跳過憑證驗證。此命令需能下載固定版本 curl image，並非在 dev 連正式 SSO。

```sh
docker run --rm --add-host 'sso.example.com:<NAS_LAN_IP>' curlimages/curl:8.10.1 \
  --fail --show-error --silent --connect-timeout 10 --max-time 30 \
  'https://sso.example.com/webman/sso/.well-known/openid-configuration'
```

- D3 真正登入時仍須驗證 id_token nonce、SSO 2FA 與使用者 sub；不得把 discovery 相容性當成完整登入驗收。
- money.example.com:443 → `http://127.0.0.1:8080`；sso.example.com:443 → DSM HTTPS 的 SSO Server。選擇有效憑證，啟用 HSTS、HTTP/2，proxy timeout 300 秒。
- 反向代理必須覆寫來自外部的 X-Forwarded-For，帶正確來源 IP。app 只信任最近一跳（TRUST_PROXY=1），只綁 loopback，不能直接對外開 8080。測試 `/api/health` 與 JSON log 的 `client_ip`。
- DSM 全帳號 2FA、自動封鎖、GeoIP 僅允許台灣與內網；停用 admin，SSO 帳號不加入 administrators。路由器只轉送 443，不對外開 DSM 5000/5001；Cloudflare 維持灰雲。
- /mcp 保留路由，第一版不建立 PAT。需要 AI 介接時才建立短效、限定帳本的 token。SSO 故障由 DSM 修復，第一版沒有 break-glass。

## 3. 首次啟動與一次性身分確認（D3，另需核准）

首次不知道 sub 時，ALLOWED_SUBJECTS 填入不會匹配真實帳號的占位識別，不能留空；暫時設 `OIDC_SUBJECT_DISCOVERY=true`。

```sh
docker compose --env-file deploy/ssh/.env.nas -f deploy/ssh/compose.nas.yaml config --quiet
docker compose --env-file deploy/ssh/.env.nas -f deploy/ssh/compose.nas.yaml up -d --wait
docker compose --env-file deploy/ssh/.env.nas -f deploy/ssh/compose.nas.yaml ps
```

透過正式 HTTPS 入口登入。只有完成 OIDC 驗證、白名單外的帳號才看到自己的 iss/sub，HTTP 403、no-store、沒有 session。管理者確認該帳號後，把 sub 寫入 ALLOWED_SUBJECTS（逗號分隔），**立刻把 OIDC_SUBJECT_DISCOVERY=false 並重建 app**：

```sh
docker compose --env-file deploy/ssh/.env.nas -f deploy/ssh/compose.nas.yaml up -d --force-recreate app
```

重新登入／登出；驗證白名單外帳號只得到 subject_denied、API 未登入 401、跨站 POST 403。檢查 Secure/HttpOnly/SameSite=Lax cookie。啟用確認模式時 app 啟動與顯示頁面都會警告，log 只記事件，不記 sub、cookie、token；audit 維持 login:denied。若沒出現頁面，先排查 issuer/client/redirect/certificate，不得關閉 JWT 驗證。

建置後先等 postgres healthy、首次初始化完成，再執行第一次備份；running 或暫時 socket 可用不代表就緒。

三服務 healthy 後，依 D3 清單做合成帳本與 P0–P3 回歸；定期檢查磁碟，保持 postgres 無 host port。使用者於核准窗口重啟 Docker/NAS，確認三服務自動恢復。

## 4. 升版與 rollback

升版前先備份並確認 restore drill 可用；依 §1 下載新版本 bundle、核對 SHA 後解壓到相同 `NAS_ROOT/deploy`（bundle 不含已填寫的 `.env.nas` 或 secrets，會保留這些本機檔案）；記錄現行 tag、三個 digest 與 migration 版本。不要使用 latest，不覆寫已發布 tag。若備份目錄放在專案資料夾內（例如 `/volume1/docker/finmichi/backup`），**不可刪除整個專案資料夾**來替換部署檔；必須保留備份與私人設定。GUI 版的 `finmichi-db` 絕對不可以刪除；舊合成 volume 可保留，人工清理方式見 [GUI README](container-manager/README.md#舊-volume-的處理)。

```sh
export BACKUP_DIR='<NAS_BACKUP_DIRECTORY>'
sh deploy/nas-backup.sh
# 編輯 .env.nas 的 IMAGE_TAG 為核准新版本（三服務同 tag）
docker compose --env-file deploy/ssh/.env.nas -f deploy/ssh/compose.nas.yaml pull
docker compose --env-file deploy/ssh/.env.nas -f deploy/ssh/compose.nas.yaml up -d --wait
curl --fail http://127.0.0.1:8080/api/health
```

再驗證 HTTPS 登入、記帳／查詢及 worker。若失敗且 schema 相容，改回前一 tag 並 pull/up。若 migration 與舊版不相容：停止 app/worker，保留故障資料目錄，先在**獨立暫時 DB** 演練升版前 dump，再由使用者於核准維護窗口手動回存正式 DB／切換備援目錄，最後啟動舊版。先記錄資料損失窗口；不要用 drill 腳本覆蓋正式 DB，也不要在 app/worker 還寫入時還原。復原正式 DB 的破壞性操作不自動執行。

## 5. DSM 備份排程與每月演練

DSM「控制台 → 任務排程表 → 排程的任務 → 使用者定義指令碼」：每日一次、使用者 root、失敗時寄 email；指令設專案絕對路徑與備份目錄。Hyper Backup 納入 BACKUP_DIR，限制存取並設定異地保留。

```sh
export PATH=/usr/local/bin:$PATH
export NAS_ROOT='<NAS_PROJECT_DIRECTORY>'
cd "$NAS_ROOT"
export BACKUP_DIR='<NAS_BACKUP_DIRECTORY>'
export KEEP=30
sh deploy/nas-backup.sh
```

腳本找不到 docker 時會明確提示 PATH 並以非 0 結束，且不建立備份目錄或 lock。

預設 container `finmichi-postgres-1`，自訂專案時可設 POSTGRES_CONTAINER。備份是讀取快照，不停止 app；.tmp 驗證成功才改名，mode 600，目錄 700，僅輪替嚴格命名的本工具檔案。失敗不留下 .tmp、不刪舊備份；重疊排程拒絕。若系統斷電留下 `.finmichi-backup.lock`，先確認沒有作業執行才手動清掉 lock 及不完整 .tmp，不可當成有效備份。

每月從指定備份做演練，保存版本與筆數：

```sh
sh deploy/nas-restore-drill.sh '<ABSOLUTE_DUMP_PATH>'
```

只建立 finmichi_drill，若已存在就拒絕，不覆蓋。成功／失敗都清除本次建立的 DB；若 daemon 中斷導致清理失敗會非 0 並提示，恢復連線後手動確認／刪除 drill DB，再重試。輸出只有最新 schema_migrations、ledgers/transactions 計數，不輸出內容。資料庫零寫入期間的來源計數才應完全相同；有並行記帳時以備份快照為準。

## 6. 行情與 secrets 輪替

D4 核准後設 MARKET_DATA_ENABLED=true，`up -d --force-recreate worker`；停用同樣改回 false。BOT 遇 Challenge 時不繞過，走管理中心「匯率」人工上傳。首次實際成功時只記 Content-Disposition 的檔名作為 evidence。TWSE/TPEx 正式網路連線在 D4 驗證，D0/CI 不連正式市場來源。

輪替 OIDC secret：在 NAS 原子換檔後重建 app；DB 密碼先在核准窗口更新角色，再同步兩份 URL 與 postgres-password，重建三服務並驗證（只改 POSTGRES_PASSWORD_FILE 不會替既有資料庫改密碼）。GHCR token 輪替後重新 login 並撤銷舊 token。禁止在 log 或 shell tracing 印出內容。

## 7. 故障排除與 D0 開發驗證

| 症狀                | 檢查                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| SSO 失敗            | issuer discovery、client 類型、redirect 完全一致、憑證與時間；檢查 oidc_failed 事件，不印出 callback query/token |
| proxy 502           | localhost /api/health、Compose healthy、DSM 目的端口、app 啟動錯誤；app 純 HTTP，勿把 DSM upstream 設成 HTTPS    |
| postgres 權限錯誤   | 查 image 的 UID/GID、postgres bind 目錄、secret mode/owner；不要 chmod 777                                       |
| Docker 重啟後未恢復 | Compose restart=unless-stopped、daemon 啟動、依賴 health；手動 stop 的容器不會自動重啟，要 up -d                 |
| worker unhealthy    | DB 可連線、migration、健康檔與退避 log；市場抓取先關閉再縮小問題                                                 |
| 備份／演練失敗      | 磁碟、容器、mode/owner、lock、既有 drill DB；不能把 .tmp 當備份，也不能忽略非 0                                  |

Release workflow 的 workflow_dispatch 永遠是 dry-run：三個 amd64 image 各自 build 與 Trivy blocking/full，同時產出只含 allowlist 部署檔（根目錄 GUI、ssh/ 為 SSH）的 deploy bundle 與 SHA-256 CI artifact，沒有 registry login/push，也不建立 GitHub Release。只有核准的 v* tag 可進 publish job；必須在 main 歷史上。所有 blocking 與 bundle 建置成功才下載原掃描 image 發布，三 digest 與 bundle SHA-256 寫到 summary 與 release notes，且逐一確認 private；bundle 及 `.sha256` 附在同 tag 的 GitHub Release。D0 不建立 tag。

D0 的合成 NAS smoke（見 scripts/nas-smoke.mjs）使用本機同版 image、臨時 secrets、隔離專案；不讀正式資料。重啟驗收必須使用獨立 Docker daemon，不得重啟共享 dev daemon。其餘 unit/DB/UI/MCP 回歸沿用 CI。

## D3 相容性補充（v0.1.2）

bundle 根目錄為 GUI 版，SSH 檔案在 `ssh/`。從 NAS_ROOT 執行本文件的指令。app/worker 停止等待 30 秒，postgres 60 秒。

SSH 版保留 json-file rotation：在 Container Manager 日誌頁會看不到日誌，請用 SSH 查看；GUI 版使用 DSM 預設 driver。DS918+ 核心不支援 pids_limit，SSH 版出現「Your kernel does not support PIDs limit capabilities」是預期警告，Docker 會忽略；其餘限制仍保留。

有資料的 DB 密碼變更程序尚未設計／驗收；目前只描述必要的角色密碼與兩份 URL 同步，不視為可直接執行的完整程序。不得以刪除 volume 代替改密碼，也不得只改 env／secret 檔。必須另行設計 recovery、驗收並取得維護窗口核准。

舊版 `life-ledger-YYYYMMDD-HHMMSS.dump` 仍可交給新版 restore drill，還原到 `finmichi_drill` 並忽略舊 owner；新版輪替只處理 `finmichi-*.dump`，不會刪除舊版備份。

### 備份錯誤分類

備份就緒檢查使用 TCP 127.0.0.1，首次初始化尚未完成時回 `db_not_ready`。錯誤代碼與安全處理方式見 [GUI README 備份任務錯誤代碼](container-manager/README.md#備份任務錯誤代碼)（部署 bundle 中為 `../README.md`）。`backup_locked` 不會刪除其他執行中的鎖；確認任務已停止後才可人工移除舊鎖。

## v0.2.2 升級設定

升級前先備份。保留私人 `.env`，但必須新增 `OIDC_HAIRPIN_HOST`，填入 `OIDC_ISSUER` 的主機名稱（例如 issuer 為 `https://sso.example.com/webman/sso`，填 `sso.example.com`），不可包含協定、port 或路徑。app 的 `extra_hosts` 會把此名稱解析到 `NAS_LAN_IP`；worker 不需要此設定。沒有設定時 Compose 直接回報 `OIDC_HAIRPIN_HOST required`，不會靜默啟動。app 啟動即做 OIDC discovery；此值不改變 TLS 憑證或 issuer 驗證。

替換 bundle 的 compose 與操作文件後，依原流程重建專案；不要覆蓋自己的密碼、allowed subjects、volume 或備份。此 PR 沒有 migration，既有帳務資料不變。文件的 `example.com`、文件用 IP 與 `dev`／`nas` 是範例，不能直接連到任何使用者部署；私人部署清單另存 Workspace。
