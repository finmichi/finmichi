<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# 受管理交易的編輯導向

股利與定存產生的交易在明細表格、手機卡片及交易編輯抽屜中，分別標示「由股利管理」與「由定存管理」。按「前往編輯」直接開啟原股利或定存設定；股利不受目前報表日期範圍限制，已結清定存也可由連結找到設定。

交易列表與單筆 API 增加 `dividend_id`、`deposit_id`，只回傳同一個已驗證 owner 帳本內的管理關聯。不改變金額、科目、成本、報表口徑或一般交易的修改限制；一般交易 API 仍拒絕修改／刪除管理交易，應由原功能執行預覽及確認。股票管理原有的股票模式不變。

管理連結使用 `/investments?tab=dividends&dividend_id=<UUID>` 或 `/investments?tab=deposits&deposit_id=<UUID>`。關閉編輯時移除管理 ID，保留其他檢視條件；未知或無權限的關聯顯示錯誤，不會開啟其他紀錄，也不會將任意 URL 參數傳給 API。沒有新增 migration。
