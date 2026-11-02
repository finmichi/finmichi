# P2-5 信用卡與貸款

口徑：ADR-0011 rev.1.3 §3、§6；備份依 ADR-0007 §6。只用合成測試，不部署。

## 設定與權限

`GET /api/ledgers/:ledger/cards`、`GET /api/ledgers/:ledger/loans` 回傳設定及只讀計算。
`PUT` 同一路徑儲存設定；`DELETE /:item` 刪除設定，保留已記錄交易。
owner 檢查在 core service，跨使用者或跨帳本參照回 404；mutation 沿用 Origin/session 保護。
新增 audit action `card.update`、`card.delete`、`loan.update`、`loan.delete`，不記金額或設定內容。
DB 以 composite FK 與 trigger 保護科目類別、旗標及同帳本參照，已合併 migration 不變。

設定只支援帳本本位幣；卡片／貸款、繳款帳戶或利息科目任一非本位幣回 400 `currency_not_supported`。選單停用非本位幣科目，既有外幣科目的一般記帳不受影響。還原遇到不符幣別的設定回 `reference_invalid`。

## 純計算

卡片以本位幣自然方向計算個別科目的累積負債。帳單期間是前次結帳隔日至本次結帳日，已繳只計結帳隔日至繳款日（含）的借記，讀取時不納入未來交易；溢繳保留負值。月底日期取最後一天；offset 0 須結帳日 ≤27 且繳款日嚴格較晚，否則 `invalid_card_schedule`。

貸款金額與年利率均為 decimal string。計算僅用 BigInt：年利率的小數 6 位整數／1,200,000,000 為月利率，annuity 以整數冪與有理數 HALF_UP 計算付款，再逐期算利息。equal_principal 或零利率以整數分 floor 分攤，尾差在末期；其他 annuity 的本金依 ADR 封頂、末期吸收餘額。日期依原始首期日逐月取月底，避免 2 月後漂移。

`自今日重新試算` 只先帶入目前餘額（HALF_UP 至 2 位）與剩餘期數，明確儲存後取代設定；攤還表與查看操作不寫入。

零付款顯示「本期無需繳款」並停用按鈕。信用卡未繳 ≤0 或缺繳款帳戶時也停用並顯示原因。其餘付款只預填非零分錄，沿用既有交易建立、PKCE/session/Origin、零和與關帳驗證。

## 備份相容

下載格式升至 schemaVersion 3，新增 `credit_card_settings` 與 `loan_settings`；full／structure 都包含，所有科目參照以同一張 items UUID 對照表改寫。v1/v2 先驗原始 payload checksum，再補空設定表；仍拒絕未知欄位、缺少必要區塊、失效參照。不停用 DB 約束。

## 驗證

`pnpm check`、`pnpm test:db`、`pnpm test:ux-finance`。DB/UI 僅能使用專用 localhost 合成資料庫。

`packages/core/src/fixtures/loan-decimal-reference.json` 是獨立 Python Decimal（precision 100、HALF_UP）計算的合成基準：P=1,200,000、年利率 2.1%、240 期，兩種方法逐期比對本金、利息、付款與期末本金。產品採 BigInt 有理數計算；測試直接讀 JSON，執行測試不需要 Python。可選的開發工具 `python3 scripts/generate-loan-reference.py` 可獨立重算並核對 fixture（只有帶 `--write` 才會重建）。

property test 覆蓋 principal 0.01–99,999,999.99、年利率 0–20%、1–600 期；每期本金與餘額非負、本金合計精確相同。另有零利率小額案例、31 日月底、付款停用及兩／三分錄、HTTP/DB ownership、稽核敏感內容掃描與舊版／full／structure 備份回歸。

UX smoke 為 1440×900、1280×800、390×844、360×780、淺深色各一組，涵蓋資料、編輯、付款、空狀態、錯誤、載入；檢查頁面無水平溢出、axe color-contrast 與無外部 CDN 請求。

付款預填先以非破壞性的 snapshot 供畫面讀取，待 React commit 後才確認取用；舊畫面的確認不會清掉較新的付款請求。回歸測試涵蓋重複 render 讀取、跨帳本隔離、過期 acknowledgment 與重複確認。Finance smoke 先執行，再跑既有整套 UI 回歸，失敗時保留合成畫面與按鈕診斷。

## PR56 UI 複驗修正

- 每個繳款按鈕的無障礙名稱包含科目與帳單結帳日，或貸款期別與繳款日；完整攤還表的同一期另加「完整攤還表」，避免重複名稱。
- 繳款預填僅移除金額字串小數部分的尾端零（例如 `1300.000000` → `1300`），不經浮點、不改數值或精度。信用卡兩分錄使用「轉帳」快速模式；貸款仍為進階模式，零額分錄仍省略。
- 貸款預設列出截至今日最近一期及下一期；尚未開始時列首兩期，全部到期後列最後一期。完整攤還表可展開，保留原有所有期別與操作。
- 卡片日期摘要將下次繳款對應的帳單結帳日標明，與下次結帳日分開呈現。
