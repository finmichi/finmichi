# Phase 1.1 schema 與金額邊界

`0003_ledger.sql` 新增 architecture §4 的十張 P1 table。0002 保留給獨立登入稽核 PR；migration runner 依檔名排序，不要求連續編號，0001 未修改。

- ledgers.owner_id 用於後续 core service 的帳本權限檢查；複合 FK 禁止 entry、parent、payee、project 跨帳本引用。
- 科目唯一鍵為 ledger/kind/lower(name)，同名不同 kind 可並存；archived 只保留資料旗標，不刪除歷史。樹循環檢查先鎖定 ledger row。
- 0005 migration 新增父子 kind 一致性 trigger（包含直接改父／子 kind），先鎖定 items 表並拒絕既有違規資料；執行時鎖定 ledger row 序列化 kind 變更與 child insert/move。父子幣別可不同。service 同樣回 400 parent_kind_mismatch；0003 不修改。
- entries 使用 numeric(20,6)，rate 使用 numeric(24,10)，拒絕 NaN/Infinity/零 amount/非正匯率。currency 必須與科目一致。
- DB deferred constraint trigger 在 commit 驗證交易至少兩個 entries、base_amount 精確零和，涵蓋 INSERT/UPDATE/DELETE 與 entry 搬移。entry 修改先按 id 順序鎖定 transaction rows，避免兩個 concurrent 不平衡更新互相抵銷。
- import SHA 唯一範圍為 ledger/status=imported；不同 SHA 或不同帳本可用。
- core money.ts 只接受 decimal string，以 BigInt 最小單位加總，拒絕超過 6 位小數與超出 numeric(20,6) 範圍，不使用 JS float。

## 符號與金額規則（ADR-0002 rev.2）

- amount 正數為 Debit：資產／費用增加，負債／收入減少；負數為 Credit，方向相反。「來源 → 目的，X」對應來源 -X、目的 +X。base 與 amount 同號且皆非零。
- amount 保留輸入，最多6位；base 固定2位；rate最多10位。HALF_UP正負對稱，完全以BigInt計算，與PostgreSQL round(numeric,2)對照。
- calculateBaseAmounts 情境A：本位幣rate必為1，base=amount且合計0。情境C：僅一筆外幣且有本位幣，以本位幣合計決定外幣base並求有效匯率（10位）；回傳超過5%的fx_rate_deviation warning供未來UI顯示。
- B/D：逐筆精確乘積round至2位，base為0回base_amount_rounds_to_zero；殘差每筆最多分攤一分，依(e-r)、|e|、輸入順序排序，跳過會歸零或變號者。不足候選或k>n回fx_residual_exceeds_tolerance，不自動新增科目。
- calculateImportBaseAmounts 是僅供importer使用的純計算／規劃函式：先檢查來源換算差額≤1.00；B/D因k>n無法分攤時回傳帶systemItem/sourceReason=fx_rounding_residual的「匯兌尾差」income/nonOperating entry，保留來源amount；超過1.00回unbalanced。不會寫DB或建立科目；完整importer的get-or-create、批次/source records/report持久化仍留Phase1.8。
- 新增0004 migration，不修改0003：base2位、同號非零、本位幣rate1/base=amount、偏差≤0.02+|amount|×1e-10。deferred檢查包含entries/transactions/ledger base_currency更新；entry先取得ledger SHARE lock，避免同時改base_currency漏驗。
- migration會拒絕既有不符合資料並回滾，不默默改寫金額。DB可接受的偏差不取代service更嚴格的逐分規則。

基本資料 CRUD API/UI 見各 Phase1.2 文件；尚未提供交易 CRUD、報表、完整CSV/MDB importer或實際匯率警告 UI，Phase1.3 待 kind 修正驗收後才接續。transaction.kind目前為constrained欄位，後續service由entries推導；P2 locked_until只預留。import_source_records.target_id為多表追溯，完整存在性驗證留匯入service。

正式決策與完整案例見 [ADR-0002 rev.2](adr/0002-money-rounding-and-zero-sum.md)。

### 收支彙總期間上限

`report_income_summary` 在產生時段前，以日曆邊界計數，最多 1,000 個時段；起訖當日所在的日／月／季／年都計入，無交易時段亦計入。第 1,001 個時段回 `400 period_range_too_large`，JSON 與 CSV 共用限制。SQL 直接呼叫亦拒絕，跨 owner 仍先回空結果／API 404。UI 依粒度提示範圍。
