# CI 分層與公開 repo 安全（PR-C／PR-N）

此變更沒有 migration、API、資料格式或 runtime 行為變更。每月 Actions 預算上限維持 US$30；不變更帳號預算、runner 或 repository visibility。PR-N 加入 gitleaks／環境識別值與合成資料掃描。

## 執行範圍

| 事件／變更                                       | 執行內容                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| PR 只有 `**/*.md` 或 `docs/**`                   | lint、Prettier、legacy-names、環境識別值、gitleaks、個資／檔案掃描                  |
| 一般 PR                                          | `pnpm check`、完整 DB 測試（含官方 SDK MCP）、依路徑選 UI                           |
| 已知 web 功能                                    | 依 `scripts/ci/plan.mjs` 對照選測；finance 選 finance 與 cash-forecast              |
| 共用／未知／後端／依賴／workflow 檔案            | foundations、daily、entry、admin、reports 五個代表性 UI；完整 DB 不省略             |
| main push、`v*` tag、`full-ci` 標籤、手動執行 CI | 26 組完整 UI、OIDC／worker／NAS 合成 smoke、獨立 daemon 離線 smoke；CI 不執行 Trivy |

新增功能時同步維護路徑對照。路徑取 immutable base/head 的 Git diff，包含 rename 的兩端與刪除路徑，不依賴 API 檔案數上限。多功能變更取聯集，未知路徑不會默默跳過 UI。一般 PR 是選測，不聲稱等同完整回歸；風險較大的 PR 應加 `full-ci`。

`full-ci` 的新增與移除都觸發重新規劃。完整模式優先於 docs-only。CI 用 PR number／ref 分組，只有 pull_request 取消舊 run，main push 不取消；Release workflow 沒有自動取消設定。版本 tag 同時觸發 CI 完整回歸與既有 Release 流程，不新增發布事件重複執行。每週保留完整非阻擋報告，另加入 worker image 與全歷史 secrets 報告。

`ci-result` 檢查所有已選 job 必須成功；預期跳過的 job 必須為 skipped，不能以取消或失敗冒充成功。未修改遠端 branch protection；若日後公開 repo 設 required checks，使用此穩定 gate。

## 快取與證據

- pnpm store 以 `pnpm-lock.yaml` 為 dependency path。
- Playwright browser key 含 OS 與 lockfile hash；系統依賴每次照常確認。
- CI／release 的 build-push-action 使用 `type=gha`，依用途／image 與 lockfile hash 區隔。快取不能取代實際測試或 Trivy。
- CI 截圖只於失敗上傳，保留 7 天；精簡 UI timing JSON、smoke 證據保留 7 天。
- Release 證據保留既有政策；weekly image 報告保留原有 retention，全歷史 secrets 報告保留 7 天。
- 關閉 build-push-action 預設 build record artifact，避免額外長期儲存。

## Workflow 安全

所有 workflow 預設 `contents: read`，所有 action 固定完整 commit SHA。PR 不執行 `pull_request_target`，只有同 repo 的環境識別掃描步驟讀取 `ENV_IDENTIFIER_PATTERNS`，fork 跳過該步驟；其他掃描仍執行，不保留 checkout credential，也沒有 image push／release 權限。快取中只有可重新建立的依賴／layer，不能存 secrets。

Release 的 publish job 與每個 secret 步驟均限定 `push` 的 `refs/tags/v*`；fork PR 不可能進入。手動 Release 仍為 dry-run，不登入 registry、不發布 image。發布前沿用 main ancestor 檢查及 private package 檢查。不得為通過 fork 測試提供 secrets。

輸入的 PR metadata、檔名不會插入 shell；執行 UI 時只接受程式內 allowlist 的 suite 名稱。actionlint v1.7.12 從官方 release 下載並驗證固定 SHA-256。

依據：[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)、[Docker GHA cache scope](https://docs.docker.com/build/cache/backends/gha/)。

## 優化前基準（verified）

取變更開始前最近五次 `CI` 的 `pull_request` run，包含失敗 run，不挑選較慢樣本。下列為 job 執行時間合計（runner-minutes），不是平行 job 的牆鐘時間，也不是帳單實際金額。

| Run         | 結果    | check | DB＋UI | app／worker | postgres | 合計分鐘 |
| ----------- | ------- | ----: | -----: | ----------: | -------: | -------: |
| 40276355666 | success |  2.28 |  47.90 |        9.92 |     0.93 |    61.03 |
| 40272847234 | failure |  2.33 |  15.62 |        9.70 |     0.85 |    28.50 |
| 40267122889 | success |  2.32 |  55.53 |       11.05 |     1.27 |    70.17 |
| 40261134545 | success |  2.37 |  52.55 |        9.63 |     1.33 |    65.88 |
| 40254243799 | success |  2.37 |  54.73 |        9.57 |     0.85 |    67.52 |

全部五次平均 **58.62** 分鐘，四次成功平均 **66.82** 分鐘。成功 run 的 UI 步驟平均 48.75 分鐘／26 suites，平均約 1.88 分鐘／suite；各 suite 耗時並不相同。

## 優化後估算（hypothesis，待實測校正）

| 模式                     | 預估 runner-minutes | 估算方式                                                                                               |
| ------------------------ | ------------------: | ------------------------------------------------------------------------------------------------------ |
| docs-only                |                 1–3 | install＋lint＋規劃／結果                                                                              |
| finance-only（2 suites） |                8–15 | check 約 2.3＋DB/build/install 約 4–7＋UI 約 3.8＋規劃／結果                                           |
| shared（5 suites）       |               15–25 | 上述固定成本＋UI 約 9.4                                                                                |
| full-ci／main／tag       |               60–75 | 完整回歸與 runtime smoke（Trivy 移至 Release／weekly）；快取實際效益依命中與下載速度，不先計入保證節省 |

快取、取消被新 commit 取代的 run 可額外省時，但不承諾金額節省比例。2026-10-29 的 US$27.69 是歷史費用，不能當作 11 月即時用量。驗收只跑必要的 probes 與一次完整回歸，不提高 US$30 上限。

## 驗證與限制

本機執行 `node --test scripts/ci/*.test.mjs`、`sh scripts/ci/actionlint.sh`、`pnpm check`。GitHub 用以本 PR 分支為 base 的暫時 probe PR，測 docs-only、重複 push 取消、finance-only，最後 `full-ci` 完整回歸；probe 不合併。

本 PR merge 前不能宣稱已驗證「main 上的新 workflow」；此時只能驗證事件契約與同內容的 full-ci。Claude 驗收及使用者核准 merge 後，仍須確認真正 main push 的完整 CI。不得以測試需要直接 push main 或提前 merge。

## 第一輪 GitHub 實測（2026-11-01）

- docs-only：41294585006 PASS，合計 0.85 runner-minutes；DB／UI／image jobs skipped。
- finance-only：41295011702 PASS，合計 12.13 runner-minutes；DB/MCP 386 tests，UI 僅 finance 157.424 秒、cash-forecast 111.455 秒。
- 連推：舊 docs run 41294547853 自動 cancelled；驗收 probe PR77 已關閉，未合併。
- full-ci：check、DB/MCP、OIDC／worker／離線 smoke 與 app／worker Trivy 通過；PostgreSQL gate 查出固定 image 的 CVE-2026-84782（libssl3／openssl，共 2 HIGH），需要另行修補，不能把此 run 當作全綠。
- 全矩陣同時揭露既有提醒 fixture 的月初日期問題：兩個月前 2 日消費、結帳 1 日、offset 1，在本月 1 日的繳款日仍是本月 20 日，因此不屬於「7 天內／逾期」提醒。合成消費移到三個月前，增加兩筆逾期提醒的前置檢查；保留 UI 顯示前三筆與 96 張矩陣的全部斷言。產品程式不改；11/1 本機 96 PNG PASS。

實測值是不同選測範圍的單次樣本，不是同一完整工作量的效能提升保證。完整矩陣重跑結果及已知阻擋以 PR／Workspace 驗收紀錄為準。

## PR-N 發布前門檻

`runtime-smoke` 保留 OIDC、worker、NAS 合成測試及 Docker 24.0.2 獨立 daemon 離線驗證；CI 移除 `postgres-scan` 與所有 Trivy 步驟。Release 的三個 image blocking gate 完全不變：HIGH／CRITICAL、ignore-unfixed=true、exit-code=1。

發布前必須先對 main 手動執行 Release dry-run，取得 app／worker／postgres 三份掃描結果，才請使用者核准發布。dry-run 不登入 registry、不推 image、不建立 release。內容掃描與精確例外的維護方式見 [content-scanning.md](content-scanning.md)。有 migration、帳務語意變更或同時修改 server 與 web 的 PR 必須加 `full-ci`。
