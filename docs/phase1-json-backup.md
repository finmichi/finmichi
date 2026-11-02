# 帳本 JSON 備份（ADR-0007 rev.1.1）

`GET /api/ledgers/:ledger/backup.json` 只允許 owner，跨使用者 404、匿名 401。回應 no-store，下載檔名為 finmichi-<slug>-<台北時間YYYYMMDD-HHmmss>.json（RFC5987 Unicode filename）。

備份以 REPEATABLE READ transaction 與帳本鎖讀取 ledger 及明確白名單的9張表：items、payees、projects、memo_templates、transactions、transaction_entries、exchange_rates、import_jobs、import_source_records。不包含 owner_id、users、sessions、audit_logs 或認證資料。

format=finmichi，schemaVersion=9（永久接受舊 life-ledger v1–v8；未知未來版本仍拒絕），含 exportedAt、appVersion、ledger、tables、counts、payloadSha256。金額／匯率以 PostgreSQL numeric 原值字串輸出；時間戳保留6位小數，分錄 entry_position 不重排。payloadSha256 只涵蓋 tables，遞迴排序 object keys、保留 array 順序、無空白的 canonical JSON；不作身分驗證或加密保證。不能把它當成數位簽章。

大小上限50 MiB／200,000交易，超過拒絕。匯入來源歷史原樣備份，包含 deleted: 標記或尚未標記的懸空 target_id；還原依 ADR-0007 §3.1 判斷，不會為了備份偷偷刪除或修補來源資料。只使用合成測試資料。

## 還原 API（rev.1.1）

`POST /api/backup-restores/preview` 與 `/confirm` 的 body 為原備份 JSON，query 只接受 mode（full／structure，預設full）與可選 name；沒有覆蓋目標帳本參數。新名稱預設「原名（還原 台北日期時間）」，最長200字元、不切斷Unicode字元；同名拒絕。

預覽嚴格驗 format／schemaVersion／所有欄位與數值字串、tables checksum、counts、50MiB與20萬交易限制，參照問題只回前20筆及總數。強參照缺失、重複ID、父子循環或格式錯誤回 reference_invalid；JSON深度最多100層。預覽不寫DB。

確認時重新驗證，在單一 transaction 建立新UUID／目前使用者的新帳本，分批500列插入，依對照表改寫所有 FK。先插入根節點後補上 parent_id，所有 DB triggers／constraints 始終啟用。原始 amount／exchange_rate／base_amount／entry_position 直接保留，不重算、不重新排序；SQL jsonb_to_recordset直接解析timestamp，避免driver經Date截掉微秒。回應包含新帳本、筆數與原ID→新ID對照表。

full保留關帳日、交易／匯率／匯入歷史；structure只有四張目錄表，locked_until清為null。Life2023 source_id只依source_system明確allowlist改寫jobUUID前綴，其他外部來源鍵原樣保留。來源紀錄的UUID目標改寫，匯率複合鍵YYYY-MM-DD|FROM|TO保留；有效格式但目標已不存在時改為deleted:原值，既有deleted:標記原樣保留。預覽按表回報懸空與已刪除筆數。

新0012只標記既有合法格式的懸空來源，不刪除紀錄、不掩蓋格式錯誤。往後刪除交易會在同一transaction標記provenance；關帳刪除拒絕時標記也不變。備份／預覽沒有audit寫入；還原audit只記backup.restore結果，不記金額／摘要／檔案內容。

## 手機操作

「備份還原」頁提供下載目前帳本、選擇JSON檔案與full／structure、預覽筆數／期間／關帳／來源警示、新帳本名稱及確認建立。名稱變更需重新預覽，結構模式清空關帳。成功後刷新帳本清單，顯示「開啟還原帳本」；原帳本不切換、不刪除。參照錯誤只顯示前20筆的位置與中文原因，不把帳務內容寫入log。

## P2 擴充（ADR-0007 rev.2.1）

v2 的 tables/counts 增加 recurring_rules、recurring_occurrences、budgets。full 保留所有狀態、next_on、原始模板字串與交易連結；structure 保留預算，規則 active=false、next_on 從 start_on 重算，occurrence 為空。worker 執行狀態不進備份。v1 先驗原 tables 的 checksum，再將三段補空；v2 缺段、未知欄位仍拒絕，無法把 checksum 當成數位簽章。

所有 UUID 重生。模板科目、收付人、專案與預算 item_id 換新。規則、occurrence.source_rule_id、recurring 交易 source_id 共用同一規則對照；已刪除規則只建立新 UUID，不重建規則。occurrence 的 null rule_id／transaction_id 保持 null，posted 交易已刪除仍保留 posted。非 null 的缺失參照或 recurring source_id 不符合 UUID:合法日期，拒絕 reference_invalid。預覽列出三種歷史筆數，不阻擋。

還原在單一 DB transaction 內新增帳本；任何新舊表的 constraint／trigger 錯誤均整批回滾，不停用限制。新增欄位數值仍為字串，稽核不記備份內容。
