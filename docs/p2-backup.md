# P2-3B：P2 第一批收尾

規格：ADR-0007 rev.2.1 §6/6.1、PR52/PR53 Claude 審查後續；只用合成資料驗證。

## 備份

匯出 schemaVersion=2；tables/counts 新增 recurring_rules、recurring_occurrences、budgets。金額與匯率維持 PostgreSQL numeric 字串；模板中的科目、收付人、專案隨 id_map 改寫。full 保留 active/next_on、所有 occurrence 狀態/error_code、posted 交易連結及月預算。structure 保留預算；規則停用，next_on 從 start_on 重算；不帶 occurrence/交易/worker 執行狀態。

v1 檔案先按原始 tables 驗 checksum，再補空的三張 P2 表；v2 缺表不接受。未知欄位、大小與交易上限沿用。checksum 是損壞檢查，沒有身分驗證或加密功能。

依 rev.2.1：蒐集現存規則、occurrence.source_rule_id、recurring 交易 source_id 的 UUID；每個不同舊規則 id 只分配一次新 UUID。已刪除規則不重建。rule_id=null、posted且transaction_id=null 均保留，非null缺失參照才拒絕。source_id 的 UUID/日期格式驗證；非 recurring/Life2023 的外部 source_id 不改。預覽三種歷史筆數只提示不阻擋。

全程單一 transaction 新建帳本，所有 trigger/constraint 保持啟用；預算 kind 限制、FK、零和錯誤都整批回滾。失敗不得留下新帳本或部分 P2 資料。使用者可保留來源帳本以供比對；不覆蓋既有帳本。

## worker 退避

migration0019只新增 recurring_worker_runs.failure_count/next_retry_at，舊 migration 不動。每帳本系統失敗採5、10、20…分鐘，最多6小時；狀態持久化，重啟仍等待。等待期間不 generate、不增加 recurring.generate audit。成功歸零；原每日06:00 Taipei gate、row lock/lease/唯一鍵不變。業務 failed occurrence 留人工確認，不當成整批系統失敗。

程序層DB/連線例外另外採30、60、120…秒，最多30分鐘；成功後重設。SIGTERM 可中斷等待，heartbeat 獨立；log只記事件/code/重試毫秒數，不記例外內容、認證或財務資料。health代表程序heartbeat，排程結果看頁面狀態。專用模擬 trigger 測試連續失敗、等待audit不變、到期重試及成功重設。

## UI

週期規則卡片逐筆列科目與原幣金額；按鈕可見文字精簡，完整規則名稱保留在 aria-label。worker 時間用臺北易讀格式，失敗顯示下一次重試。

報表③今年預設當月（季為當季、年為全年；其他年度為第一期）；period 為 URL view-only allowlist參數，不送API，也不改CSV全年口徑。切時段後重載／上一頁可還原。data-chart-theme 對應實際theme。預算月格編輯時原始字串、失焦後千分位與2位小數；錯誤格式/超額精度不默默四捨五入，仍留待API驗證。

不新增依賴。完成後開PR停等Claude驗收，不自動merge、不部署NAS、不建立tag。
