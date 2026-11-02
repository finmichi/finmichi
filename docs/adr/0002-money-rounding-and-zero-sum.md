> 本專案已更名為 FinMichi；以下保留當時的決策與識別。

# ADR-0002：金額精度、Rounding 與精確零和

日期：2026-10-16｜決策者：Claude（規劃），使用者可覆議｜狀態：Accepted（rev.2，2026-10-16）
回應：PR #8（Phase 1.1 schema）Codex 提出的 rounding mode、匯入容許誤差、差額入帳規則。

## 1. 符號慣例

- `amount > 0` = 借方（Debit）：資產／費用增加、負債／收入減少。
- `amount < 0` = 貸方（Credit）：資產／費用減少、負債／收入增加。
- Life2023「來源項目 → 目的帳目、金額 X」＝ 來源 entry `-X`、目的 entry `+X`。
- `sign(base_amount) = sign(amount)`（同號；兩者皆不得為 0）。

## 2. 精度

| 欄位                        | 規則                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `amount`（原幣）            | 照輸入／來源保存，**不做 rounding**；上限 6 位小數（numeric(20,6)）                                                 |
| `base_amount`（本位幣 TWD） | **固定 2 位小數**：`base_amount = round(base_amount, 2)`                                                            |
| `exchange_rate`             | numeric(24,10)；本位幣 entry 必為 `1`                                                                               |
| 本位幣 entry                | `currency = ledgers.base_currency` 時，`exchange_rate = 1` 且 `base_amount = amount`（因此 amount 也最多 2 位小數） |

## 3. Rounding mode

- **ROUND_HALF_UP（四捨五入，絕對值方向遠離零，正負對稱）**，精度 2 位。
- 與 PostgreSQL `round(numeric, 2)` 語意一致；`packages/core/money.ts` 以 BigInt 實作同一規則並以測試對照（含 `±0.005`、`±1.005`、`±2.675` 等邊界）。
- 對稱性保證 `round(-x) = -round(x)`，同幣別同匯率的借貸自動精確抵銷。

## 4. 精確零和的達成規則（service 層）— rev.2

> rev.2 修正 Codex 重現的兩個邊界：(1) 原情境 B 在三筆以上 legs 時不一定零和（例：rate=1、amount=[0.005, 0.005, −0.010]，HALF_UP 後合計 0.01）；(2) 原情境 D 把最多 0.01×n 的殘差併入單筆，n≥6 時違反 §6 偏差上限。rev.2 以「逐分分攤」取代「單筆吸收」，B 與 D 合併為同一演算法。

**情境 A — 全部為本位幣**：`base_amount = amount`；amount 合計必須為 0。

**情境 C — 有本位幣 entry，且只有一筆外幣 entry**：實際匯率法（不變）。外幣 entry `base_amount = −(本位幣 entries 合計)`；`exchange_rate` 存有效匯率 `|base|/|amount|`（四捨五入至 10 位）；偏離當日參考匯率 > 5% 時 UI 警告但允許。

**情境 B/D 合併 — 其他所有含外幣的交易（含同外幣同匯率多腿）**：

1. 本位幣 entries 照 A 精確計算，令 `T = −Σ(本位幣 base)`（無本位幣 entry 時 T=0）。
2. 每筆外幣 entry i：精確乘積 `e_i = amount_i × rate_i`（BigInt decimal，不得用 float），`r_i = HALF_UP(e_i, 2)`。
3. 若任一 `r_i = 0` → 拒絕，錯誤碼 `base_amount_rounds_to_zero`。
4. 殘差 `R = T − Σr_i`（必為 0.01 的整數倍），`k = |R| / 0.01`，外幣 entry 數 `n`。
5. `k = 0` → 完成。`k > n` → 拒絕，錯誤碼 `fx_residual_exceeds_tolerance`（由使用者調整匯率／金額，或另加一筆「匯兌損益」entry）。
6. `1 ≤ k ≤ n` → 選出 k 筆不同的外幣 entry，各調整 `sign(R) × 0.01`（**每筆最多調整一次**）。候選排序：
   - `R > 0`：`(e_i − r_i)` 由大到小（先調整被捨去最多者）；`R < 0`：由小到大。
   - 同值依 `|e_i|` 由大到小，再依 entry 輸入順序。
   - 調整後若使 `base_i = 0` 或 `sign(base_i) ≠ sign(amount_i)`，跳過該筆改取下一候選；候選不足 k 筆 → 拒絕 `fx_residual_exceeds_tolerance`。
7. 結果性質：每筆 `|base_i − e_i| ≤ 0.015`，Σbase 精確等於 T。

範例（Codex 案例 1）：rate=1（非本位幣）、amount=[0.005, 0.005, −0.010] → r=[0.01, 0.01, −0.01]，R=−0.01，k=1；候選依 `(e−r)` 由小到大為第 1、2 筆（−0.005），但調整後 base=0 → 跳過；第 3 筆調整為 −0.02 → base=[0.01, 0.01, −0.02]，合計 0。

不在 A–D 自動產生任何科目；超出容許值一律需要使用者明確處理。

## 5. 匯入（E-Money）容許誤差與差額

- 配對檢查容許誤差：換算後 `|Σbase| ≤ 1.00 TWD`（沿用 account_app `analyzeEmoney` 的判定，以利與既有核對基準比較）。超過 → `unbalanced`，不匯入，列入報告。
- 帳戶 legs 一律保留來源原幣金額（確保各帳戶原幣餘額與來源一致）；外幣 leg 的 base 依情境 C 或 B/D 合併演算法計算。
- 0 < 殘差 ≤ 1.00 且 B/D 演算法無法分攤（k > n）時：新增第三筆 entry 到系統科目 **「匯兌尾差」**（kind=`income`、`non_operating=true`、本位幣），金額 = 殘差，並在 `import_source_records` 與報告中標示 `fx_rounding_residual`。
- 系統科目「匯兌尾差」與「期初／調整」（kind=`equity`，用於單邊紀錄）在匯入前由 importer 以 `(kind, name)` get-or-create，並標示為系統建立。
- 對帳報告需列出：尾差筆數、尾差合計、`unbalanced` 筆數與差額合計。

## 6. DB 層補強（PR #8 後續，需新 migration，不得修改 0003）

1. `CHECK (base_amount = round(base_amount, 2))`。
2. `CHECK (sign(base_amount) = sign(amount))`。
3. deferred trigger 增加：本位幣 entry 必須 `exchange_rate = 1 AND base_amount = amount`。
4. deferred trigger 增加（rev.2）：`|base_amount − round(amount × exchange_rate, 2)| ≤ 0.02 + |amount| × 1e-10`。
   - 0.02 涵蓋 B/D 逐分分攤（≤0.015）；`|amount| × 1e-10` 涵蓋情境 C 有效匯率四捨五入至 10 位造成的誤差（≤ 0.5e-10 × |amount|）。
5. 文件化第 1 節的符號慣例（docs/phase1-schema.md）。

## 7. 必測案例（service 與 DB）

- 本位幣收支、轉帳（A）。
- USD 帳戶付 USD 費用科目，匯率 32.567、金額 33.33（兩腿，R=0）。
- 同幣同匯率三腿 rate=1、amount=[0.005, 0.005, −0.010] → base=[0.01, 0.01, −0.02]（跳過會歸零的候選）。
- 六筆外幣、R=0.06 → 六筆各 +0.01，皆符合 §6 偏差上限；R=0.07 → 拒絕。
- 微小金額 base 四捨五入為 0 → `base_amount_rounds_to_zero`。
- 情境 C 大金額（amount=99,999,999.999999，有效匯率 10 位）通過 §6 公式。
- 台幣科目記錄 USD 100 支出，實際扣台幣 3,251 → USD leg base −3,251、有效匯率 32.51（C）。
- USD → JPY 轉帳加台幣手續費（B/D）：k ≤ n 時逐分分攤、k > n 時拒絕。
- 邊界：±0.005、±1.005、±2.675 的 HALF_UP 結果與 PostgreSQL `round` 一致。
- DB：本位幣 entry 匯率 ≠ 1 拒絕；base 3 位小數拒絕；異號拒絕；偏差超過 `0.02 + |amount|×1e-10` 拒絕。
- 匯入：殘差 0.37 → 產生「匯兌尾差」entry；殘差 1.01 → `unbalanced`。

## 8. Property-based test 不變量（rev.2.1 澄清，不改變 §4–§6 規則）

所有情境（成功結果）：

- `Σbase_amount = 0`（精確）。
- 每筆 `base_amount ≠ 0`、`sign(base_amount) = sign(amount)`、`base_amount` 為 2 位小數。
- 本位幣 entry：`exchange_rate = 1` 且 `base_amount = amount`。
- 每筆符合 §6 DB 公式：`|base − HALF_UP(amount × exchange_rate, 2)| ≤ 0.02 + |amount| × 1e-10`。
- 失敗只可能是 ADR 定義的錯誤碼：`invalid_money_entry`、`unbalanced`、`base_amount_rounds_to_zero`、`fx_residual_exceeds_tolerance`。

情境 B/D 額外驗證（`exact_i = amount_i × rate_i`，以輸入 rate 計算）：

- `|base_i − exact_i| ≤ 0.015`，且 `|base_i − HALF_UP(exact_i, 2)| ≤ 0.01`（每筆最多調整一次）。
- 被調整的筆數 `= |R| / 0.01 ≤ n`。

情境 C 額外驗證（**不套用 0.015**）：

- 外幣 entry `base = −Σ(本位幣 base)`（精確）。
- 儲存的 `exchange_rate = HALF_UP(|base| / |amount|, 10)`。
- 偏差只受有效匯率 10 位 rounding 影響，理論上 `≤ 0.005 + 0.5e-10 × |amount|`，並須符合 §6 DB 公式。
  - 例（Codex 2026-10-16）：amount=−99,999,999,999,999.123456、base=−3,251,000,000.99、rate=0.0000325100 → 偏差 0.99，符合 DB 上限（約 10000.02），屬預期行為。

## 變更紀錄

- rev.1（2026-10-16）：初版。
- rev.2（2026-10-16）：依 Codex 重現案例，情境 B 併入 D，改為每筆最多 ±0.01 的逐分分攤；新增 `base_amount_rounds_to_zero`；§6 偏差上限改為 `0.02 + |amount|×1e-10`；補必測案例。
- rev.2.1（2026-10-16）：新增 §8 property test 不變量；明確 0.015 只適用 B/D，C 以有效匯率 rounding 與 §6 DB 公式驗證（回應 Codex 大金額 C 案例）。
