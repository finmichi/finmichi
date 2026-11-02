# E-Money offline importer (brief 1.8)

Only generated CSV fixtures are included. Never place real MDB, CSV exports, private mappings, datasets, baselines, or reports in this repository. Real MDB acceptance is a separate user-authorized 驗收工作站 operation; Codex/dev uses synthetic CSV only. P3 stock/deposit tables are parsed into staging/report and never written to investment tables.

## Analyze and transform

```sh
pnpm install --frozen-lockfile
pnpm build
node tools/emoney-import/dist/cli.js analyze --input tools/emoney-import/fixtures --out /private/analysis.json
node tools/emoney-import/dist/cli.js transform --input tools/emoney-import/fixtures --out /private/dataset.json
# Optional explicit private overrides, with SHA256 captured in the dataset/job report:
node tools/emoney-import/dist/cli.js transform --input /private/export/SHA256 --out /private/dataset.json --mapping /private/mapping.json --opening-date 2020-01-01
```

Reports/datasets are written via a mode-0600 temporary file and atomic rename. Existing explicitly selected output files are replaced. Stdout contains counts and warning codes only; full financial details remain in the private report. Analyze and transform never connect to the DB. Fatal errors produce exit 1 with a report, skipped groups remain explicitly listed. Transform output containing errors cannot be imported.

Manifest contracts match `tools/mdb-export`: source SHA, source file date, export timestamp and per-table row counts/SHA. Every CSV is UTF-8, with BOM/quoted commas/escaped quotes/newlines supported, uppercase headers, equal-width rows. Files must be regular non-symlinks; table names cannot contain paths. Limits: 50 MiB per CSV/dataset, 200 MiB per bundle, 200,000 rows per table, 1 MiB per record. No Access driver is loaded by the app. Fixture source SHA is a generated synthetic identifier, not a claim that a real MDB was exported.

## Decisions

ADR-0002 §5, ADR-0007 §3.1 and ADR-0008 rev.1.1 apply. All kinds use IN−OUT; negative income/expense natural totals show `sign_convention_suspect` at the top of the dry-run report. All arithmetic uses existing BigInt money functions, including `calculateImportBaseAmounts`, HALF_UP and exact zero-sum constraints. Original amounts remain unchanged. Single legs are adjustment entries against system equity `期初／調整`; import-only residuals use system non-operating income `匯兌尾差`. Both are marked `system_created` in dataset/job provenance.

Class/currency defaults are exactly ADR-0008's six classes and eight currency aliases (including blank TWD). No guessing by rate, name, or current market prices. Unknown values and counts are all reported. Mapping is strict: `item_classes`, per-item `items` (class+exact trimmed name, higher priority), `currencies`, `opening_rates` (item name → explicit rate), `exclude_opening` (exact item name). Only the synthetic example belongs in git. `(kind, lower(trim(name)))` prevents same-name asset/liability collisions. Parent references stay within the same kind; missing/conflicting/cyclic trees fail. Referenced group headers are real accounts. Names are not fuzzy matched.

Rows group by DATA_KEY or documented one-based `fallback:MAKE_NO2:index`. A missing mapped account/date/project skips the **whole group**, never just one side. Conflicting dates/payees/projects in one group are errors. Empty IN/OUT numeric cells represent MDB NULL and count as zero; NaN, exponential, whitespace-only nonempty invalid numeric strings and overprecision are not converted to zero. Zero legs are explicitly reported. Source fields DATA_NOTE and DATA_NOTE2 are preserved as unique text fragments joined by newline.

Each foreign leg uses its source EXCHANGE, otherwise a CURRENCY_SET rate on that exact transaction date; never a rate guessed from currency magnitude or today's date. CURRENCY_SET accepts RATE_DATE/EXCHANGE_DATE/DATA_DATE. Price staging accepts PRICE_DATE/DATA_DATE; absence uses SOURCE_DATE and `as_of_source=true`. Invalid present dates are reported rather than replaced by today. Trade/deposit dates are parsed and retained.

Nonzero asset/liability BEFORE_MOUNT creates an independent opening adjustment at the earliest valid source transaction date minus one day, or EXPORTED_AT's date minus one if no valid transaction. `--opening-date` must precede the earliest transaction. Foreign opening rate is ITEM_DATA.EXCHANGE, overridable through `opening_rates`; missing/nonpositive is `opening_rate_missing`. Source key is `ITEM_DATA:<trim(ITEM_CLASS)>|<trim(ITEM_NOTE)>:opening` (ADR-0008 rev.1.3). Non-balance-item openings are warned and not booked. Possible duplicate single-leg openings are warned, both remain unless explicitly excluded. The report lists every opening, signed amount, base amount, date and warnings.

All unbalanced (>1.00) groups and their signed difference are reported. The generated fixture contains a 0.37 residual (booked to FX rounding) and a 1.01 residual (skipped `unbalanced`). Reconciliation must explicitly review skipped records, not treat a successful import as complete historical correctness.

## Apply and reconcile

```sh
# No DB connection or write is made unless --apply is present.
node tools/emoney-import/dist/cli.js import --input /private/dataset.json --out /private/dry-run.json
# DATABASE_URL is provided by the operator environment, never a committed file or CLI argument.
node tools/emoney-import/dist/cli.js import --input /private/dataset.json --out /private/import-result.json --apply --owner-subject SYNTHETIC_SUBJECT --ledger-name 'Synthetic migration'
node tools/emoney-import/dist/cli.js reconcile --owner-subject SYNTHETIC_SUBJECT --ledger-name 'Synthetic migration' --out /private/reconcile.json --baseline /private/baseline.json
# Offline reconciliation of the planned result:
node tools/emoney-import/dist/cli.js reconcile --input /private/dataset.json --out /private/planned-reconcile.json
```

The apply path requires an existing, uniquely identified OIDC subject; a subject present under multiple issuers is rejected rather than picking an owner. It creates a **new TWD ledger**, catalogs, dated rates, jobs/provenance and all transactions in one transaction, with 500-transaction/1000-entry batches. All DB constraints/triggers remain enabled. An owner row lock serializes duplicate checks. Any imported job with the same source SHA in any ledger owned by that user (including JSON restores) returns `already_imported_for_owner` with ledger names in the private error report. Only explicit `--allow-duplicate-ledger` permits another new ledger and is recorded in the job report. Name collisions still fail. No `ledger_id` option exists; existing ledgers are never populated. Different source hashes can create independent ledgers.

Dataset checksums cover canonical JSON of the entire plan; this is corruption detection, not authenticity or encryption. Never edit a dataset to conceal errors. Apply refuses any fatal errors and writes only validated plan rows; P3 staging is preserved in import_jobs.report, never investment tables. Success/error audit records contain action/outcome only, never amounts, memo, token or report. emoney-mdb transaction source IDs remain external keys, and JSON restore preserves them unchanged.

Reconciliation reads all transactions and per-account original/base currency balances at a repeatable-read snapshot. Assets use signed base; liabilities reverse sign; net worth is assets minus liabilities. It includes transaction count, categorized skipped/errors, FX residual count/signed total, and opening count. Private baseline JSON uses the same reconciliation object shape; a subset of top-level fields may be supplied, but each supplied balance list is compared completely by `(kind,name,currency)`, and count maps include missing/extra categories. Monetary strings compare exactly via BigInt (different decimal padding is equivalent). Unknown baseline fields fail. Difference reports contain paths/expected/actual values; exit 2 means mismatch, exit 1 means input/DB error, exit 0 means success. Reports remain private and must not be attached to issues, Workspace or PRs when using real data.

If output publication fails after a committed apply, the DB result is still committed; reconcile by owner/name before retrying. The owner-wide duplicate check makes an accidental retry fail closed. Recovery is verification of the newly created ledger; this tool has no overwrite/delete operation. Do not disable constraints to import historical data.

## ADR-0008 rev.1.2: source rate and staging warnings

A TWD transaction leg always uses `amount = IN_MOUNT − OUT_MOUNT` and rate 1. Its source EXCHANGE is ignored, including malformed reference values. A supplied value other than a valid numeric 1 increments `warning_counts.source_rate_ignored_base_leg`. Foreign transaction legs retain their source rate; a resolved source rate of 1 increments `foreign_leg_rate_one`, without guessing or correcting it. The usual C/BD money rules still calculate exact balanced base entries.

All raw P3 cells remain strings exactly as exported, including original decimal padding/precision and date syntax. Known staging validation failures produce `staging_*` warnings with counts and table/row/field details, never errors or skipped ledger groups; six-decimal stock prices are retained and warned against the four-place staging price reference precision. Valid parsed dates are annotations (`parsed_*`), not replacements of source cells. Unknown tables are preserved as uninterpreted string records. Their contents are not coerced into ledger entries. Unknown staging currencies remain visible in counts without requiring mapping for `--apply`.

`warning_counts` and `warning_details` are additive report metadata, defaulting to empty for older datasets/job reports. They are included in analyze/dry-run output and import_jobs.report. Fatal checks for booked source tables remain fatal, including nonnumeric MYMONEY_DATA amounts; pre-existing explicit skipped-group classifications remain unchanged. Export manifest/hash/row-count/file-integrity and CSV-envelope checks still fail closed: staging warnings apply to cell parsing, never authorize bypassing corrupted export verification.

### ADR-0008 rev.1.3：期初來源鍵

期初交易及其 provenance 使用 `ITEM_DATA:<trim(ITEM_CLASS)>|<trim(ITEM_NOTE)>:opening`，不使用 ACCOUNT_ID／MAKE_NO。重複的 trimmed `(ITEM_CLASS, ITEM_NOTE)` 一律為 fatal `duplicate_item_identity`，即使期初為 0 也不例外。transform 結束前驗證所有計畫交易的 `(source_system, source_key)`（目前 source_system 固定為 emoney-mdb）；重複回 fatal `duplicate_source_key`，診斷只含類別及出現次數，不列鍵值內容。apply 的重複檢查仍是第二道防線。既有 plan 不會自動改鍵，須重新 transform。

### ADR-0008 rev.1.4：明確確認科目幣別

`item_currencies: [{ "item_class": "資產", "item_note": "合成日圓帳戶", "currency": "JPY" }]` 依來源 trimmed `(ITEM_CLASS, ITEM_NOTE)` 精確比對，優先於 EXCHANGE_NOTE（含全域 currencies mapping）；不做名稱模糊比對、大小寫轉換或依匯率猜幣別。mapping 的 pair 必須在 ITEM_DATA 存在，否則 `mapping_item_not_found`；同 pair 重複 override、非三碼大寫幣別或未知欄位也是 mapping 驗證錯誤。舊 mapping 沒有此欄時預設空陣列。

沒有逐科目明確 mapping 的 asset/liability，若 EXCHANGE_NOTE 解析為 TWD，且 ITEM_DATA.EXCHANGE 非空且非 1，回 fatal `ambiguous_item_currency`；report errors 的 key 是來源 pair JSON、count 是列數（包含重複列，後者另有 duplicate_item_identity）。非數字參考匯率也不視為已確認幣別。

明確指定 TWD 表示確認本位幣，忽略 ITEM_DATA.EXCHANGE；來源 EXCHANGE 非空時記 `item_rate_ignored_base_currency` warning 與次數，即使它是 1 或非數字。指定外幣後仍用既有來源匯率與 money 演算法；沒有發明匯率。所有修改 mapping 都須重新 transform，實際 mapping 檔保持私人、不進 repo，SHA256 照舊寫入 import_jobs.report。

## P3-6：股票／定存轉入（ADR-0012 §6.1）

只對已成功執行原始 E-Money 帳務匯入的帳本操作；bundle 的來源 SHA-256 必須相同。這個命令不接觸 MDB，只讀 mdb-export 的 CSV bundle。開發與 CI 僅用 `fixtures-investments/` 合成資料。

先準備私人 mapping（格式見 `investments.mapping.example.json`，範例所有名稱皆為合成）。科目可用 UUID，或在要求的 kind 中唯一的名稱；`{"create":"名稱"}` 只在 `--apply` 時建立。新增的手續費／損益科目自動設為業外；既有科目必須已符合 kind、幣別與業外條件。不要把私人 mapping、bundle 或對帳報告放進 repository／Workspace。

```bash
# DATABASE_URL 使用執行環境提供的私人設定，不將認證寫入命令或 repo。
pnpm build
node tools/emoney-import/dist/cli.js investments \
  --input /private/export/SHA256 \
  --mapping /private/investments.mapping.json \
  --ledger-id LEDGER_UUID --owner-subject OIDC_SUBJECT \
  --out /private/investments-dry-run.json

# 確認私人報告後，重跑同一組參數並加 --apply。
# 預設撤銷也只試算；加 --apply 才刪除該次投資轉入。
node tools/emoney-import/dist/cli.js investments --revert JOB_UUID \
  --ledger-id LEDGER_UUID --owner-subject OIDC_SUBJECT \
  --out /private/investments-revert.json --apply
```

報告先寫入同目錄 `.tmp.<UUID>`，以 mode 0600 原子替換。投資報告路徑不得位於 Git checkout；stdout 僅列模式與筆數，錯誤鍵、金額差異、科目與銀行資料只進私人報告。請自行保存報告，不加入 Workspace evidence。

- 防重分成原帳務與投資兩種 import job；同一帳本同一來源只能各成功匯入一次。`source_mismatch` 代表找不到相同來源的原帳務匯入；`already_imported` 代表投資已轉入。
- 轉入 trade 的 `origin=emoney`、`transaction_id=null`；`source_transaction_id` 僅供追溯。即使原收支分錄形狀不同，也不接管或重寫。找不到收支對應時列為未連結。
- 持股與移動平均成本沿用股票引擎。價格 HALF_UP 4 位，成本以整數分計算。價格修正、來源價金差異與定存期數差異列為 warning。
- 定存以唯一銀行前綴 mapping；analyze 遇到沒有對應時，在私人錯誤報告提供建議前綴。已到期者為 matured，沒有 transaction／posting。銀行、note 不寫入 audit。
- dry-run 無 DB 寫入；apply 與 revert 各在單一 transaction 中完成。錯誤回滾，失敗的 apply 只留 action/outcome audit。
- revert 不動原始帳務，還原證券科目旗標。已有 app trade／股利／定存 posting／續存會回 `revert_blocked`。mapping 建立的普通科目會保留，避免刪除使用者可能已使用的科目；可另在管理中心處理。
- 對帳差額不會自動產生調整分錄。不得把對帳報告當成已經完成真實資料驗收；真實 MDB 驗收由 Claude 在 驗收工作站、另經使用者授權後執行。

### 撤銷後重跑 `create`

新版本會在投資 job 的 report 只保存建立科目的 UUID（不保存名稱或金額）。撤銷後刪除投資資料與來源列，保留 `validated` 且 `report.reverted=true` 的 job 作為來源證據，這些 job 不算已匯入。相同帳本中，只有上述 job 建立、同名同 kind／幣別／業外設定、未封存且無卡片／貸款／證券旗標的科目，才能由同一 `create` mapping 重用；不會重設科目屬性或刪除科目。備份 full 還原會換新來源 UUID。

舊版已撤銷的 job 已被刪除，無法安全回推建立者；舊 job 也沒有科目建立清單。這些科目必須由使用者將 mapping 的 `create` 改為明確名稱或 ID 引用，不能僅憑同名自動重用。
