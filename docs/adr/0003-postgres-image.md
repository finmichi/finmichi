> 本專案已更名為 FinMichi；以下保留當時的決策與識別。

# ADR-0003：PostgreSQL image 弱點處理

日期：2026-10-16｜決策者：Claude｜狀態：Accepted

## 背景（verified：Claude 以 aquasec/trivy:0.65.0 掃描 `postgres:17-bookworm@sha256:3645570c…`）

- HIGH 95、CRITICAL 4；其中 **可修補 HIGH 24、CRITICAL 1 全部位於 `/usr/local/bin/gosu`**（Go stdlib v1.24.6）。
- 其餘 74 項為 Debian 套件、目前無修補版本。
- compose 已以 `user: postgres` 執行，entrypoint 不會呼叫 gosu。PostgreSQL 只在內部 network、無 host port。

## 決策

1. 新增 `deploy/postgres.Dockerfile`：`FROM postgres:17-bookworm@<最新 17.x digest>`，`RUN rm -f /usr/local/bin/gosu`，`USER postgres`。不執行 apt upgrade（避免與上游套件版本漂移；改以定期更新 base digest 取得修補）。
2. 該 image 納入 CI 掃描：blocking 規則與 app 相同（可修補 HIGH/CRITICAL 擋下）；完整報告上傳 artifact。
3. compose.dev／staging／nas 改用此 image（staging/nas 透過 GHCR 發布 `ghcr.io/finmichi/life-ledger-postgres:<tag>`）。
4. 每週掃描若出現可修補項，更新 base digest 並開 PR。
5. 驗收：移除 gosu 後 `pg_isready` healthy、DB 整合測試通過、Trivy blocking 0。
