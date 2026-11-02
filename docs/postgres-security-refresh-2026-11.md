# PostgreSQL image 安全更新（PR-V）

2026-11-01；只更新 `deploy/postgres.Dockerfile` 的 upstream digest，不含 migration、CI 政策或應用程式異動。

## 版本與修補

| 項目                 | 舊 image                                                                  | 新 image                                                                  |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Tag                  | `postgres:17-bookworm`                                                    | `postgres:17-bookworm`                                                    |
| Index digest         | `sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826` | `sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5` |
| linux/amd64 manifest | `sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df` | `sha256:2cd2c0f809604aaeff6f0ec8f40aecbd025613107561015c69369a1a7f1d3416` |
| PostgreSQL           | `17.11-1.pgdg12+2`                                                        | `17.11-1.pgdg12+2`                                                        |
| libssl3 / openssl    | `3.0.22-1~deb12u1`                                                        | `3.0.22-1~deb12u2`                                                        |

這是同一 PostgreSQL 17.11 的作業系統安全更新，沒有虛構 17.x → 17.y 的 minor 升級。官方 [Debian tracker](https://security-tracker.debian.org/tracker/CVE-2026-84782) 列出 CVE-2026-84782 的 Bookworm 修補版本。掃描確認套件命中，不代表已證明 FinMichi 可由外部觸發該 OpenSSL 路徑。

衍生 image 繼續刪除 `/usr/local/bin/gosu`、使用 `USER postgres`（UID/GID 999）；未加 `apt upgrade`。四種 Compose、TCP healthcheck、掛載位置與 hardening 都不變。

## Trivy 比較

兩個衍生 image 都使用 Trivy 0.75.0、同一 DB（UpdatedAt `2026-11-01T07:08:40.846369079Z`）；第二次起關閉網路並使用 `--skip-db-update`，避免資料庫更新造成假差異。

| 嚴重度   | 舊完整報告 | 新完整報告 | 未修補（前 → 後） |
| -------- | ---------: | ---------: | ----------------: |
| CRITICAL |          3 |          3 |             3 → 3 |
| HIGH     |         63 |         61 |           61 → 61 |
| MEDIUM   |        168 |        160 |         158 → 158 |
| LOW      |        170 |        168 |         168 → 168 |
| UNKNOWN  |          6 |          5 |             4 → 4 |

Blocking 掃描 `--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1`：舊版 2 HIGH、exit 1；新版 0 HIGH / 0 CRITICAL、exit 0。原 CVE 在新版不再命中；未修補總數 394 → 394。完整報告保留所有嚴重度；`.trivyignore` 仍為空檔。

## 相容性驗證

- 舊 image 新建隔離合成 volume，執行原 migration runner 至 `0028_emoney_investments.sql`（28 筆），透過既有 `scripts/report-fixture.mjs` 建立 T0–T5：1 帳本、6 交易、13 分錄。
- 正常停止舊 container，以新 image 啟動同一 volume，再執行 migrate。migration 名稱、checksum、套用時間、所有 public 表筆數、完整分錄與三份報表一致；報表只排除其 `generated_at`，不排除財務欄位。
- `v0.2.1` 原版 `nas-backup.sh` 在舊 image 產生合成 dump，新 image 的 `nas-restore-drill.sh` 成功還原；另外還原到專用驗證 DB，比對相同 schema、筆數、分錄、收支彙總、分類統計、資產負債表。
- `pnpm install --frozen-lockfile`、`pnpm check`：PASS（294 單元／property tests）。新 image 的 `pnpm test:db`：386 PASS，包含 MCP、備份還原與資料隔離測試。
- Docker 24.0.2 離線與首次初始化 TCP readiness：結果隨 PR 驗收證據記錄，不以 image build 成功代替。

## 發布與限制

本 PR 從 `main` 建立，先於 CI 優化 PR-C 合併；PR-C 須於本 PR 經核准合併後 rebase 並重跑完整 CI。未調整掃描門檻，未部署 NAS、未打 tag。

目前 main 的提醒 UI 合成 fixture 有月初日期邊界問題：11 月 1 日不能產生原斷言需要的兩筆逾期提醒。該 fixture 修正留在 PR-C；本 PR 不夾帶應用或測試修改，也不放寬斷言。CI 若遇到此既有失敗，須明列結果並交 Claude 決定合併順序，不宣稱全綠。

若相容性失敗，可用新的 commit 還原舊 digest，保留合成驗證結果；舊 image 具有已知可修補 HIGH，回復後不得當作安全 gate 通過。正式升級與 rollback 仍需另行授權，本輪只有合成資料驗證。
