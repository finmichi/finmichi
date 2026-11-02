> **Pre-alpha：目前不支援他人安裝，資料格式可能變動**

<h1 align="center">FinMichi</h1>
<p align="center"><b>Your Life. In Balance.</b><br>自架、私有的個人複式記帳網站（PWA）與 MCP 服務</p>

---

FinMichi（Fin＝Finance、Michi＝道）是一套**單人自用、部署在自家 NAS** 的帳務系統。功能來源為「帳務小管家 Life2023」，歷史資料可一次性從 E-Money MDB 轉入。所有帳務採用**複式記帳**：每一筆交易的分錄合計必須為零。另外提供**唯讀＋草稿**的 MCP 端點，讓 AI 助手可以查詢帳務、提出記帳草稿；草稿一律經人工確認後才入帳。

> 本專案原名 **life-ledger**，2026-10 起更名為 FinMichi（ADR-0013）。`v0.1.x` 以前的 tag、Release 與 GHCR image 仍保留舊名稱；舊版 JSON 備份（`format: life-ledger`）可以永久還原。

## 目錄

- [功能](#功能)
- [設計原則](#設計原則)
- [架構](#架構)
- [專案結構](#專案結構)
- [開發](#開發)
- [測試](#測試)
- [部署](#部署)
- [備份與還原](#備份與還原)
- [MCP](#mcp)
- [安全](#安全)
- [開發流程與分工](#開發流程與分工)
- [文件索引](#文件索引)
- [Roadmap](#roadmap)

## 功能

| 類別         | 內容                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 帳本與科目   | 多帳本、科目樹（資產／負債／收入／支出／權益）、業外與固定性旗標、多幣別、收付對象、專案、摘要範本                                                       |
| 記帳         | 複式交易（分錄零和）、外幣與匯率、記帳抽屜、明細查詢與篩選、關帳（期間鎖定）                                                                             |
| 週期交易     | 規則、到期產生、待確認清單、自動入帳選項                                                                                                                 |
| 報表         | 資產負債表（含市值重估）、收支彙總、分類統計、預算 vs 實際、損益表、淨值流量、帳戶異動、資金預估、專案分析                                               |
| 信用卡與貸款 | 台幣與外幣信用卡帳單、繳款預填、額度使用率；貸款攤還表（本息平均攤還、本金平均攤還）                                                                     |
| 投資         | 台股上市與上櫃（含 ETF），移動平均成本；買賣、配股、調整；股利（除息日與發放日、所得代碼明細如 54C）；定存（利息試算、按月或到期付息、續存）；已實現損益 |
| 行情與匯率   | 臺銀牌告匯率、證交所與櫃買收盤價（worker 自動抓取，臺銀受阻時可人工上傳匯率 CSV，不繞過來源限制）；交叉匯率                                              |
| 提醒中心     | 定存到期、卡費、貸款、週期交易、AI 草稿、行情過期；已讀狀態與內容變更偵測                                                                                |
| 匯入與匯出   | E-Money MDB 一次性轉入（帳務＋股票＋定存，含對帳報告與撤銷）、Life2023 8 欄 CSV、JSON 完整備份與還原（含結構還原）                                       |
| MCP          | 唯讀查詢工具與報表、記帳草稿（`draft` scope）、PAT 管理（有期限、限定帳本、可撤銷）                                                                      |
| 稽核         | 登入、寫入、MCP 呼叫的 audit log（只記 action 與 outcome，不記內容）                                                                                     |
| 介面         | 響應式 PWA（桌面與 390px 手機）、淺色與深色主題、WCAG AA 對比                                                                                            |

## 設計原則

- **金額精確**：金額為 `numeric(20,6)`、匯率為 `numeric(24,10)`；程式中以十進位字串與 BigInt 運算，**不使用浮點數**；四捨五入規則見 ADR-0002。
- **零和**：每筆交易依本位幣金額，分錄總和必須為 0，由 DB 與服務層同時檢查。
- **不重複入帳**：匯入、股利、定存、配股都以來源鍵與管理關聯防止重複；E-Money 轉入的投資紀錄不改寫既有分錄。
- **人工確認**：AI 草稿、週期交易、匯入都可以先預覽，確認後才寫入；**自動入帳 0 筆**為預設。
- **Migration 只增不改**：已 merge 的 migration 不得修改；重跑冪等；checksum 改變時拒絕啟動。
- **只用合成資料測試**：真實 MDB、帳單、憑證、密碼不得進入 repo 或 CI。

## 架構

```
Internet → Cloudflare DNS（DNS only）→ DS918+ DSM 反向代理（wildcard TLS、HSTS）
  money.example.com → 127.0.0.1:8080  FinMichi app
  sso.example.com   → DSM SSO Server（OIDC）

Container Manager 專案 finmichi
  app       Fastify：PWA 靜態檔、/api、/auth、/mcp（只綁 127.0.0.1）
  worker    週期交易、草稿到期、行情與匯率（提醒於查詢時計算）
  postgres  PostgreSQL 17（只在 internal 網路，不開 port）
```

| 元件   | 技術                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------- |
| 前端   | React、TypeScript、Vite、PWA、Mantine、ECharts                                                                       |
| 後端   | Node.js 22、Fastify、`postgres`（porsager）、zod                                                                     |
| 資料庫 | PostgreSQL 17（純 SQL migrations）                                                                                   |
| 登入   | OIDC Authorization Code＋PKCE（Synology SSO Server），`ALLOWED_SUBJECTS` 白名單；session 存於 DB，token 只存 SHA-256 |
| 容器   | distroless Node 22（nonroot 65532）、唯讀檔案系統、`cap_drop: ALL`、no-new-privileges                                |
| CI     | GitHub Actions：lint、typecheck、unit、DB、UI 回歸（Playwright）、Trivy、Docker 24 離線 smoke                        |

## 專案結構

```
apps/
  web/        PWA 前端
  server/     Fastify API、OIDC、MCP
  worker/     背景排程
packages/
  core/       服務層、zod schemas（REST 與 MCP 共用）
  db/         SQL migrations 與 DB 存取
tools/
  mdb-export/     E-Money MDB 匯出（mdbtools 容器）
  emoney-import/  E-Money 轉入 CLI（帳務與投資）
deploy/       compose（dev／NAS／Container Manager）、備份與還原演練腳本、RUNBOOK
docs/         功能文件與 ADR
scripts/      UI 回歸、smoke、release 工具
```

## 開發

需求：Node.js 22、pnpm（以 corepack 啟用）、Docker（Compose v2）。

```bash
git config core.hooksPath .githooks     # 本機禁止直接推送到 main
pnpm install --frozen-lockfile
pnpm check                              # lint + typecheck + unit + build
bash deploy/setup-dev.sh                # 產生本機合成 secrets 與自簽憑證（deploy/local/，不進 Git）
docker compose -f deploy/compose.dev.yaml up -d --build
curl --cacert deploy/local/tls-cert https://localhost:8443/api/health
```

- 開發環境使用 mock OIDC，登入帳號為 `synthetic-allowed`（`synthetic-denied` 應得到 403）。
- 服務只綁 loopback；從其他機器測試時，請用 SSH port forwarding（8443、8081）。
- 詳細說明見 [deploy/RUNBOOK.md](deploy/RUNBOOK.md)。

## 測試

```bash
pnpm check                 # 全部 unit／property 測試與 build
pnpm test:db               # 需要 TEST_DATABASE_URL，指向隔離的合成測試 DB
pnpm test:ux-<suite>       # Playwright UI 回歸，例如 test:ux-finance、test:ux-dividends
```

- `pnpm test:db` **不可**指向任何正式資料庫。
- UI 回歸涵蓋 1440 淺色與 390 深色版面、溢出與 WCAG 對比。
- 部署相關的離線 smoke 在 Docker 24.0.2 獨立 daemon 上執行（與 DS918+ Container Manager 相同版本）。

## 部署

正式環境為 Synology DS918+（DSM 7.4、Container Manager 24.0.2）。

| 方式                                           | 說明                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Container Manager 專案（建議，純網頁操作）** | 從 Release 下載部署 zip 與三個 image tar，在 Container Manager 匯入 image、建立專案；見 Release 內的 `README.md` |
| SSH                                            | 使用 `ssh/` 目錄中的 compose 與 RUNBOOK                                                                          |

- Release 由 `v*` tag 觸發：建置三個 linux/amd64 image（`ghcr.io/finmichi/finmichi`、`finmichi-worker`、`finmichi-postgres`，package 可見性須由維護者另行核准），Trivy 可修補的 HIGH／CRITICAL 為 0 才發布；附上部署 bundle（tar.gz 與 zip）、image tar 與逐檔 SHA-256。
- **升版**：先備份 → 匯入新版 image → 修改 `.env` 的 `IMAGE_TAG` → 專案「建置」→ 確認 health 與登入。
- **資料保護**：正式資料 volume 固定為 `finmichi-db`，**絕對不可以刪除**。Container Manager 24 沒有 volume 管理畫面；舊 volume 可保留，或先確認為可丟棄的舊合成資料後由 SSH 精確移除，詳 [GUI 部署清單](deploy/container-manager/README.md#舊-volume-的處理)。
- **首次備份**：建置後先等 postgres 變成 healthy、首次初始化完成，再執行第一次備份。
- **替換部署檔**：若備份放在專案內，例如 `/volume1/docker/finmichi/backup`，不可刪除整個專案資料夾。只替換部署檔，保留 `.env`、備份與其他私人檔案。
- **注意**：`POSTGRES_PASSWORD` 只能使用英數字，且第一次啟動後不得直接修改；Container Manager 的「清除」不會刪除 named volume。

## 備份與還原

- **每日 DB 備份**：DSM 任務排程表執行 `nas-backup.sh`（`pg_dump -Fc`，驗證可讀後才保存，保留 30 份），再由 Hyper Backup 送往異地。
- **還原演練**：`nas-restore-drill.sh` 只還原到暫時的 `finmichi_drill` DB，核對 schema 版本與筆數後刪除，不觸碰正式 DB。建議每月執行一次。
- **JSON 備份**：在網站的管理中心下載與還原（完整或只還原結構）。可還原的格式為 `life-ledger` v1–v8 與 `finmichi` v9（未支援的未來 schemaVersion 仍明確拒絕）。

## 外幣帳戶的帳面與市值

資產負債表的「帳面」欄使用交易當時的匯率。E-Money 轉入的部分外幣分錄沒有匯率紀錄（`foreign_leg_rate_one`），帳面上的台幣金額可能失真；這類帳戶應以「市值」欄的臺銀匯率重估值為準，並確認行情日期。沒有行情時市值會以帳面值代替且標示，不能把該替代值當成已完成重估。本次只補文件，不修改計算或歷史分錄。

## MCP

- 端點 `POST /mcp`（Streamable HTTP），只接受 `Authorization: Bearer <PAT>`，不接受 cookie。
- `read` scope：帳本、科目、交易查詢、餘額、各種報表（含持股、股利、定存、提醒）。
- `draft` scope：建立記帳草稿與建議科目；草稿須在網站「AI 交易草稿」頁由人工核准才會入帳。
- 不提供刪除或直接寫入帳務的工具；每次呼叫都寫入 audit log。PAT 需設定期限與限定帳本，用完請撤銷。

## 安全

- 正式環境的 secrets（DB 密碼、OIDC client secret、GHCR token、PAT）只存在 NAS 與使用者的密碼管理器，**不得**出現在 Git、Issue、PR、log 或對話中。
- 登入流程（state、nonce、PKCE verifier）只存在 app 記憶體中，最多 10 分鐘；app 重啟後尚未完成的登入會回 400 `invalid_auth_flow`，重新登入即可。已完成的 session 存在 PostgreSQL，期限 7 天、閒置 24 小時逾時。
- 目前只支援單一 app instance。
- Runtime image 與 Trivy 規則見 ADR-0001；`.trivyignore` 維持空檔；未修補的上游弱點保留完整報告，由每週 security workflow 追蹤。

## 參與貢獻與授權

程式碼採 [AGPL-3.0-only](LICENSE)，提交使用 DCO，詳 [CONTRIBUTING.md](CONTRIBUTING.md)。名稱與 Logo 的使用依 [商標政策](TRADEMARK.md)；第三方元件授權見 [依賴授權報告](docs/third-party-licenses.md)。

安全性問題請依 [SECURITY.md](SECURITY.md) 私密回報，勿在公開 Issue 或 PR 貼出漏洞、憑證或真實財務資料。官方容器僅支援 **linux/amd64**。目前為 pre-alpha，部署文件是開發與驗證參考，尚未提供對外安裝支援。

## 文件索引

- [專案分析與專案篩選](docs/project-analysis.md)
- [刪除帳本與原廠重置](docs/data-reset.md)

- 功能：`docs/phase1-*.md`、`docs/p2-*.md`、`docs/phase3-*.md`、`docs/p3-market-data.md`
- UX：`docs/ux-*.md`
- ADR（repo 內）：`docs/adr/`
- 部署：`deploy/RUNBOOK.md`、Container Manager `README.md`、bundle 內的 `ssh/RUNBOOK-nas.md`（repo 為 `deploy/RUNBOOK-nas.md`）

## Roadmap

目前提供核心帳務、報表、投資與 MCP 功能，持續進行 pre-alpha 的功能與安全性驗證。對外安裝、升級與相容性承諾尚未穩定；後續版本以正式 Release Notes 為準。

## v0.2.2 升級設定

升級前先備份。保留私人 `.env`，但必須新增 `OIDC_HAIRPIN_HOST`，填入 `OIDC_ISSUER` 的主機名稱（例如 issuer 為 `https://sso.example.com/webman/sso`，填 `sso.example.com`），不可包含協定、port 或路徑。app 的 `extra_hosts` 會把此名稱解析到 `NAS_LAN_IP`；worker 不需要此設定。沒有設定時 Compose 直接回報 `OIDC_HAIRPIN_HOST required`，不會靜默啟動。app 啟動即做 OIDC discovery；此值不改變 TLS 憑證或 issuer 驗證。
