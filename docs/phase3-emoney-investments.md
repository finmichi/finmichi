# P3-6 E-Money 投資轉入

規格來源：Workspace ADR-0012 §6.1。CLI 使用方式與私人 mapping 見 `tools/emoney-import/README.md`。

新增 migration 0028：`security_trades.origin` 與同帳本來源交易 FK（刪除來源後設 null）；`import_jobs.kind` 分離帳務與投資防重；允許證券、trade、定存來源紀錄。保留既有金額、同帳本參照、股票科目限制與交易零和約束。

股票模式修改／刪除 emoney trade 仍經預覽、關帳檢查、重算與確認；它們只更新成本快照，不建立、更新或刪除帳務交易。app trade 的現金／費用分錄仍沿用既有重算保護。原 E-Money 一般交易可刪除；含證券科目的更新仍拒絕。

持股來源從最後一次歸零之後計算；已出清部位保留最後一段來源。歸零後新的 app 買進不再被標為 mixed。UI 顯示 E-Money 轉入／混合來源，MCP 使用相同 core service。

備份 schemaVersion 8 包含 trade origin、來源交易與投資 import job kind。full 還原重建 UUID 與來源關聯；來源交易缺漏時設 null。job 的證券科目旗標復原 metadata 也同步改寫，以便還原後撤銷。v1–v7 檔案補上 app／null／ledger 預設，不重算歷史。structure 保留證券／定存設定、不帶 trade／投資匯入 job。

驗證只用合成 CSV fixtures；所有財務計算使用既有 BigInt 股票／定存計算。CLI 不連外。私人報告以 0600 寫入 Git checkout 以外的位置，不保存到本 repo 或 Workspace。

ADR rev.1.14：realized-gains 依證券、origin、是否有 transaction_id 分組；保留既有賣出與 set_cost／cash_return 損益。每組與整份報表都有 booked_total／unbooked_total，total 保持相加以相容既有消費者。booked 依 transaction_id，不由 origin 推斷。損益表仍只讀實際帳務分錄。E-Money trade 修改不得變更類型（emoney_trade_type_locked）；DB 也禁止 emoney adjust。
