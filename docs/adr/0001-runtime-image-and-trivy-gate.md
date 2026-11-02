> 本專案已更名為 FinMichi；以下保留當時的決策與識別。

# ADR-0001：Runtime image 與 Trivy gate 政策

日期：2026-10-15｜決策者：Claude（規劃），使用者可覆議｜狀態：Accepted

## 背景（verified，來源 evidence/phase0-2026-10-15/ci-trivy-failed.log）

- runtime `node:22-bookworm-slim`（Debian 12.15）＋ `apt-get upgrade`：OS 48 HIGH + 1 CRITICAL，**全部無修補版本**（will_not_fix／affected／fix_deferred），例如 zlib1g（CRITICAL, will_not_fix）、util-linux、libsystemd0、perl-base、gzip。
- Node 12 HIGH：11 個在 `/usr/local/lib/node_modules/npm`（runtime 不需要的 npm 本體），1 個是 `@fastify/static@8.3.0`（GHSA-83w8-p2f5-377r，有修補版）。
- `ignore-unfixed: false` 時，任何 Debian 基底都會因上游未修補 CVE 永久失敗，gate 失去「可行動」意義。

## 決策

1. **Runtime base 改為 distroless**：`gcr.io/distroless/nodejs22-debian13:nonroot`；若該 tag 尚未發布，使用 `gcr.io/distroless/nodejs22-debian12:nonroot`。一律以 digest 固定。無 shell、無 apt、無 npm/corepack、預設非 root（UID 65532）。
   - build stage 維持 `node:22-bookworm-slim`（digest 固定），不進入最終 image。
   - healthcheck 改為 exec 形式：`["CMD", "/nodejs/bin/node", "/app/healthcheck.mjs"]`，不得依賴 shell。
2. **Trivy gate 重新定義（不是放寬可修補項目）**：
   - Blocking：`severity: HIGH,CRITICAL`＋`ignore-unfixed: true`＝**任何有修補版本的 HIGH/CRITICAL 一律擋下**。
   - Non-blocking 報告：同一 job 另跑一次 `ignore-unfixed: false`、`exit-code: 0`，輸出 table/JSON 並上傳 artifact，保留未修補風險的可見性。
   - `.trivyignore` 只允許逐條加入，且每條需註明 CVE、理由、到期日（最長 90 天），並同步記錄在本 ADR 附錄；預設為空。
   - 新增 `schedule`（每週）掃描 `main` 的 image，讓新公開的 CVE 被發現。
3. **依賴修補**：`@fastify/static` 升至含修補的版本；以 `pnpm audit --prod --audit-level high` 作為額外 check。
4. **第三方 image**（postgres、mock-oauth2-server）：不納入 blocking gate（非本專案建置），納入每週 non-blocking 掃描並記錄。
5. **Branch protection 不可用（GitHub Free private repo，HTTP 403）**：接受現況，以流程補償——
   - 禁止直接 push `main`（AGENTS.md 規則＋本機 `pre-push` hook 拒絕推 `main`）。
   - Merge 條件：`gh pr checks` 全綠＋Claude 驗收通過＋使用者同意；merge 由使用者或經使用者明確授權的 Codex 執行。

## 後果

- 最終 image 不含 shell，除錯需 `docker run --entrypoint` 搭配 debug 變體（`:debug-nonroot`，僅限本機排障，不得部署）。
- Node 22 於 2027-04-30 EOL；在 P4 前另立 ADR 評估升級 Node 24 LTS（build 與 distroless 同步）。

## 驗收

- CI `container-scan`（blocking）綠燈；non-blocking 報告 artifact 存在。
- 最終 image 內無 `/bin/sh`、無 npm（`docker run --entrypoint /nodejs/bin/node <img> -e "require('fs').accessSync('/bin/sh')"` 應失敗）。
- compose healthcheck 在 distroless 下為 healthy。

本次使用者進一步限制：`.trivyignore` 必須維持空檔，不能加入任何 ignore；本次不得 merge 或建立 tag。
