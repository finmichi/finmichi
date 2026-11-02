# P2-2 週期交易

依 Workspace ADR-0010 rev.1 §2、§4、§5、§6；不包含預算／報表③。

## 規則與當期資料

管理中心 `/admin/recurring` 提供規則清單、快速／進階交易樣板、頻率預覽、停用與刪除。`?view=pending` 是待確認頁；其他未知 URL 參數不送 API。每月 31 日不足取月底，但下個月仍恢復原訂 31 日；每 N 個月以開始月份為錨點。每週依指定星期、每年 2/29 在平年取 2/28。

產生到今天（Asia/Taipei，含）時，把樣板複製成當期快照。後續修改規則只影響尚未產生的期數；修改當期金額、日期、摘要不會回寫規則。當期科目／分錄數不變。未明確指定的外幣匯率於入帳時由既有交易服務依當期日期取得，不把表單自動帶入的參考匯率永久固定。

入帳完全重用 `createTransaction`：ADR-0002 計算、同帳本資源、封存、關帳、零和與 audit 規則沿用。領域錯誤回傳已保存的 `failed` 與錯誤碼，UI 用中文及 `--warn` 顯示，修正後可重試；不留下部分交易。批次入帳逐期處理，保留每期結果。略過不建立交易。刪除規則只刪 pending／failed，posted 交易及其來源快照保留。

原排程 `occurs_on` 與可修改的交易日期 `occurred_on` 分開；`source_id` 永遠為原規則 UUID＋原排程日。規則刪除後 source_rule_id 仍保留，因此唯一鍵使用 `(source_rule_id, occurs_on)`；nullable rule_id 只作有效規則參照。

## API

所有路徑前綴為 `/api/ledgers/:ledger/recurring`，session／Origin／owner 隔離與既有 API 一致。

| 方法／後綴                             | 用途                                            |
| -------------------------------------- | ----------------------------------------------- |
| GET 根路徑                             | 規則、pending+failed 數量、最後 worker 結果     |
| POST 根路徑、PUT `/:id`、DELETE `/:id` | 建立、完整更新、刪除規則                        |
| POST `/generate`                       | 產生到今天；auto_post 規則也嘗試入帳            |
| GET `/occurrences`                     | 預設 pending+failed；可指定 status              |
| PATCH `/occurrences/:id`               | 修改當期日期、金額、摘要                        |
| POST `/occurrences/:id/post`、`/skip`  | 單筆入帳／略過                                  |
| POST `/post`                           | ids（1–100、不得重複）批次入帳；UI 分批處理全選 |

mutation 以帳本 row lock 與 occurrence row lock 序列化；產生另有 DB 唯一鍵，手動／worker 同時執行不會重複。入帳 savepoint 失敗只回滾該筆建立，再保存 failed。audit 新增 recurring.create/update/delete/generate/post/skip，只記 action／outcome，不記樣板、名稱、金額、日期或摘要。

## worker 與 dev compose

`apps/worker` 每 30 秒檢查一次；Asia/Taipei 06:00 前不執行，之後每帳本每日成功一次。首次於 06:00 後啟動會補跑。DB durable claim 避免多 worker 同時執行，running lease 五分鐘，系統錯誤留 error 並於後續輪詢重試；業務 failed 留待人工修正，不反覆自動入帳。崩潰後既有 pending auto_post 仍可補處理。

```bash
bash deploy/setup-dev.sh
docker compose -f deploy/compose.dev.yaml up -d --build --wait
docker compose -f deploy/compose.dev.yaml ps
```

worker 使用相同固定 digest 的 distroless runtime，65532:65532、read_only、cap_drop ALL、no-new-privileges、pids 256、512 MiB、log rotation、tmpfs；不開網路埠、不提供 shell／npm。Node healthcheck 驗證 heartbeat。app／worker 各有內容相同但 inode 分開的 dev database-url 檔案，保留 SELinux 私有 `:Z`，避免共享 inode 被另一個容器 relabel 而 EACCES。啟動腳本只在缺少 worker 檔案時複製，既有配置不覆寫。

CI 保留全部既有 job，新增 worker 容器實測、可修補 HIGH／CRITICAL blocking scan 與完整 non-blocking JSON／table report。`worker-container-smoke.mjs` 只允許 CI 或明確 synthetic opt-in，且要求全新無帳本資料庫。測完刪除自己建立的合成資料。

## 驗證與限制

自動測試涵蓋 ADR §4 日曆邊界、HTTP → DB、worker／手動競態、入帳冪等、auto_post 成敗、封存／關帳／缺匯率、跨 owner 404、刪除保留交易、系統失敗重試與無敏感內容 audit。新頁面加入管理中心既有 smoke，另有四尺寸×雙主題的規則／待確認／抽屜／確認／總覽矩陣與 390px 完整生命週期操作。

本批只驗證 dev 主機 隔離 dev 容器；未部署 staging／NAS、未建立 release tag，worker 未新增 GHCR 發布。既有 ADR-0007 JSON 備份 schema 不變，尚不包含週期規則／待確認狀態；已入帳交易仍依既有備份規則保存。worker health 表示程序存活，實際排程成功／失敗請看頁首 worker 結果與結構化 log。
