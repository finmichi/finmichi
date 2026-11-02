# finmichi Phase 0 RUNBOOK

本版只在 dev 開發；DS918+ 部署須使用者核准，尚未執行。所有驗證只用合成資料。需要 Docker Compose、Node 22、pnpm 10.18.3、OpenSSL。

## 開發啟動

```bash
pnpm install --frozen-lockfile
pnpm check
bash deploy/setup-dev.sh
docker compose -f deploy/compose.dev.yaml up -d --build
docker compose -f deploy/compose.dev.yaml ps
curl --cacert deploy/local/tls-cert https://localhost:8443/api/health
```

dev 如 Docker socket 權限不足，在 Docker 指令前加 `sudo`。setup-dev 不覆寫既有設定。Secrets 位於 Git 排除的 `deploy/local/` 與 `deploy/.env`；不要輸出檔案內容或提交。開發 HTTPS 憑證有效 30 天，只用於 localhost；在測試瀏覽器信任 `local/tls-cert`。登入 mock 時使用 `synthetic-allowed`；使用 `synthetic-denied` 應得到 403。主機 IP、真實 subject、正式 secrets 不寫入 repo。

服務只綁 loopback；如由 驗收工作站 測試，使用 SSH local port forwarding（8443 與 8081）並信任開發憑證。PWA 安裝需受信任的 HTTPS；不支援離線帳務寫入。Mock HTTP transport 只在 NODE_ENV=development 啟用，且只允許指定 issuer origin；正式環境不得設定 MOCK_OIDC_INTERNAL_URL。

## 整合測試

CI 使用全新 PostgreSQL service。`pnpm test:db` 需要指向隔離合成測試 DB 的 `TEST_DATABASE_URL`；不可指向任何正式資料庫。`pnpm build` 先建立 packages。Migration 重跑冪等；已套用 SQL checksum 改變會拒絕啟動，每檔單一 transaction。Core 測試包含 session hash、allowlist、7 天期限、24 小時閒置與 logout。

## Staging 啟動（dev）

在 `deploy/.env.staging` 填入 `PUBLIC_URL`（HTTPS）、`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`ALLOWED_SUBJECTS`、`TRUST_PROXY`（直連 0；單層受信任 proxy 1）、`DATABASE_URL_FILE=/run/secrets/database-url`。如需 confidential client，使用 `OIDC_CLIENT_SECRET_FILE`；檔案位於本機 SECRET_DIR。前方 HTTPS proxy 必須由操作人員預先建立。此範本沿用外部已建立的隔離 DB，Phase 0 未配置 NAS/SSO。

```bash
IMAGE_TAG=v0.0.1 SECRET_DIR=/path/to/local-secrets docker compose -f deploy/compose.staging.yaml pull
IMAGE_TAG=v0.0.1 SECRET_DIR=/path/to/local-secrets docker compose -f deploy/compose.staging.yaml up -d
```

## 升版與 rollback

只使用通過 PR CI 與 Trivy 的 tag，經核准 merge 後發布。升版前保留原 image tag 並在獲准環境備份 DB；app 啟動時先跑 migrations。改用新 IMAGE_TAG，執行 pull、up，再檢查 health 與登入。失敗時改回舊 tag 再 up；若 DB 不相容，停止 app 並由操作人員回存部署前備份。Migration 只能新增，不能修改已 merge 的檔案。Phase 0 未建立帳務 schema。

## 備份與回存命令範例

以下只供獲准操作人員在指定環境執行，本次沒有真實 dump。備份不可提交 Git。開發演練只使用合成測試 volume。

```bash
mkdir -p backups
chmod 700 backups
docker compose -f deploy/compose.dev.yaml exec -T postgres pg_dump -U finmichi -d finmichi -Fc > backups/synthetic.dump
docker compose -f deploy/compose.dev.yaml exec -T postgres createdb -U finmichi finmichi_restore
docker compose -f deploy/compose.dev.yaml exec -T postgres pg_restore -U finmichi -d finmichi_restore --exit-on-error < backups/synthetic.dump
```

回存到全新 DB，先核對 migration、合成 users/session/audit 筆數與登入行為，再決定是否切換。不得覆蓋正式 DB或自行刪除 volume。停止開發服務可用 `docker compose -f deploy/compose.dev.yaml down`，不加 `-v`，保留資料。備份與真正 NAS release 驗收由 Claude/使用者另行執行。

## ADR-0001 runtime 與檢查

App runtime 固定為 Node 22 distroless Debian 13 nonroot，UID/GID 65532，沒有 shell/npm/apt。App healthcheck 直接執行 `/nodejs/bin/node /app/healthcheck.mjs`，會依 TLS_CERT_FILE/TLS_KEY_FILE 選擇 HTTP 或 HTTPS。Dev mount 的 secrets 必須讓 UID 65532 可以讀取；setup-dev 的本機目錄仍保持 private。

Mock 6.0.7 是無 shell 的 Java image，不能用 wget；Dockerfile.mock-oidc 使用固定 Go build image 編譯一個靜態 HTTP probe，最終只加入 probe，不加入 Go/compiler/shell。PostgreSQL 與 mock 原始 image 每週保留完整 Trivy 報告，不作 blocking gate。

Production app listener 預設純 HTTP；不要設定 TLS_KEY_FILE/TLS_CERT_FILE，由受信任 proxy 終結 TLS。PUBLIC_URL 仍必須是外部 HTTPS origin，cookie 維持 Secure；單層 DSM proxy 使用 TRUST_PROXY=1。直接測試可設 HOST=127.0.0.1、PORT=8080；容器內預設綁 0.0.0.0，再由 Docker 只發佈 127.0.0.1。OIDC discovery 在 production 只接受 HTTPS，必須提供有效且受信任的測試 issuer，不能啟用 MOCK_OIDC_INTERNAL_URL。

PR/release：可修補 HIGH/CRITICAL 阻擋；未修補項目保留完整 table/JSON artifact。`.trivyignore` 空檔。每週 workflow 必須在 merge 後才會由 GitHub default branch 排程；本次不得 merge 或打 tag。

## dev secrets 與正式環境權限

`setup-dev.sh` 只產生本機合成測試設定、自簽憑證與隨機測試密碼。`deploy/local` 目錄為 700；為讓 UID 65532 的 dev container 讀取獨立 bind-mounted files，檔案為 444。這個模式只適用 dev，不得複製 `deploy/local` 或 `.env` 到 staging／正式環境。

正式環境 TLS 由 DSM reverse proxy 終結，app 使用 HTTP listener，不設定 `TLS_KEY_FILE`／`TLS_CERT_FILE`，也不需要在 app 放 TLS private key。`PUBLIC_URL` 仍須 HTTPS 以維持 Secure cookie。本文只是操作規範，不授權部署或修改 DSM。

正式 DB URL／OIDC client secret 由使用者在主機安全位置建立，供 app UID 65532 讀取，檔案 owner 65532:65532、mode 0400，host 的上層目錄只允許管理者存取。僅以 read-only 單檔掛載到 `/run/secrets`，不放入 image、Git、Workspace、環境變數明文或 log。不要使用 dev 的 444 權限；不要讓其他共用主機使用者讀取。若未來選擇 app 自行終結 TLS，private key 也遵循同樣權限，並另行取得部署核准。

既有 `*_FILE` 環境變數只保存掛載路徑；備份與回存需保留權限，不把正式 secrets 放進合成驗收資料。

## 開發 network 位址池用盡

不需要指定 subnet 時沿用 `compose.dev.yaml` 的 Docker 自動配置。主機位址池用盡時，先檢查既有 network 與主機 route，選擇未占用且不與 LAN/VPN 重疊的 IPv4 CIDR，再使用 optional override；不刪除其他 project 的 network。

```bash
export DEV_SUBNET='<UNUSED_PRIVATE_IPV4_CIDR>'
docker compose -f deploy/compose.dev.yaml -f deploy/compose.dev.network.yaml config --quiet
docker compose -f deploy/compose.dev.yaml -f deploy/compose.dev.network.yaml up -d
# 清理時使用相同 project 與兩份檔案；只清理本 project。
docker compose -f deploy/compose.dev.yaml -f deploy/compose.dev.network.yaml down
```

`DEV_SUBNET` 未提供時 override 明確失敗；一般啟動不載入 override，因此不改變現有預設。各隔離驗收 project 應使用不同未占用 subnet。

## PostgreSQL 衍生 image（ADR-0003）

`deploy/postgres.Dockerfile` 固定上游 postgres:17-bookworm digest，僅移除未使用的 gosu，預設 USER postgres；不執行 apt upgrade。2026-10-16 以 skopeo inspect 確認上游 tag 的最新 digest 仍為目前固定值。dev 使用本機 build，staging 使用與 app 相同 tag 的 ghcr.io/finmichi/finmichi-postgres，DB 不開 host port。

啟動 dev 前執行 `docker compose -f deploy/compose.dev.yaml build app postgres mock-oidc`。staging 的 DATABASE_URL_FILE 必須指向此 project 的 postgres service，SECRET_DIR 另提供 postgres-password；app/DB role、DB name 皆 finmichi。沿用原 volume 時密碼與 role 必須與既有初始化一致，不可用此變更重設既有 DB。

CI 的 DB tests 使用同一衍生 image；新增 PostgreSQL vulnerability blocking gate（fixable HIGH/CRITICAL），完整報告另含未修補漏洞與 secret scanner，exit0。既有 app gate 不變；.trivyignore 保持空檔。weekly 掃描 main build 的衍生 image；出現可修補漏洞時依 ADR 更新 base digest、開 PR 並重跑 healthy/DB/scan 驗證，不執行 apt upgrade 或忽略 CVE。

Release 同一 job 會先完成 app 與 postgres 的兩個 blocking scans，全部通過才開始推送兩個 linux/amd64 images，推送前檢查既有 package 私有，推送後以 API 確認 Private。新 package 預設 Private，來源：[GitHub Container registry 文件](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。本 PR 不建立新 tag 或執行發布。compose.nas.yaml 尚未建立；NAS 部署仍需另行核准，未進行任何 NAS 操作。

## P3-1 行情抓取（預設停用，部署仍需核准）

`compose.dev.yaml` worker 提供 `MARKET_DATA_ENABLED: ${MARKET_DATA_ENABLED:-false}`。
只有明確要驗證外部行情時才在本機 dev `.env` 加上 `MARKET_DATA_ENABLED=true` 並重建 worker；不要 commit `.env`。這次 P3-1 驗證只跑 mock HTTP 與合成資料，沒有啟用既有主機服務或部署 NAS。CI 固定使用合成回應，worker 的 CI 環境禁止全球 fetch。

來源連線僅程式 allowlist 的四個固定 HTTPS 主機，20 秒與 8 MiB 上限，不跟隨 redirect。臺銀回 HTML 挑戰時不要繞過；在管理中心「匯率」手動上傳自行下載的公開牌告 CSV。首次自動成功的 Content-Disposition 檔名必須另記部署 evidence。TPEx 在 dev 逾時，正式部署時仍需驗證連線。官方次年度日曆尚未發布時使用平日估算標記，不虛構年度涵蓋。

關閉旗標並重建 worker 即停止抓取；市場快取不進帳本備份、不改帳務。完整來源契約、人工上傳與退版方式見 [P3-1 市場資料](../docs/p3-market-data.md)。
