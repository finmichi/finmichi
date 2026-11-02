// SPDX-License-Identifier: AGPL-3.0-only
import { resetErrors } from './data-reset-messages';
const messages: Record<string, string> = {
  ...resetErrors,
  securities_require_twd_ledger: '股票功能目前僅支援本位幣為新臺幣的帳本',
  security_item_invalid: '證券科目必須為新臺幣資產，並開啟證券旗標。',
  security_account_required: '請選擇交割、投資費用與投資損益科目。',
  security_account_invalid:
    '請確認交割科目為本位幣資產，投資費用與投資損益為業外科目。',
  insufficient_shares: '歷史交易出現持股不足，整筆異動未寫入。',
  adjust_cost_required: '調整為零股時，必須同時沖銷剩餘成本。',
  deposit_term_invalid: '定存期間不符合計息方式；按月計息需為完整月數。',
  deposit_amount_invalid:
    '利息與扣項不可為負，扣繳加補充保費不可超過應發利息。',
  deposit_currency_mismatch: '撥入帳戶與定存科目必須使用相同幣別。',
  deposit_period_posted: '這一期已處理，請先撤銷原入帳紀錄。',
  deposit_managed_transaction: '此交易由定存管理，請到定存頁撤銷入帳。',
  deposit_renewal_in_use: '續存定存已有入帳紀錄，請先撤銷下一期入帳。',
  deposit_has_postings:
    '定存已有入帳紀錄，只能修改銀行與備註；其他異動請先撤銷入帳。',
  dividend_amount_mismatch: '股利組成合計或實發金額不一致，請核對通知金額',
  dividend_empty: '請填寫現金股利或配股股數',
  pay_date_required: '請填寫股利發放日',
  dividend_account_required: '請選擇股利入帳科目',
  dividend_account_invalid: '股利科目種類或幣別不符',
  dividend_managed_trade: '這筆配股由股利管理，請到股利頁修改或刪除',
  dividend_managed_transaction:
    '這筆交易由股利管理，請到投資的股利頁修改或刪除',

  emoney_trade_type_locked:
    '此紀錄不能改變類型；如需調整成本，請另新增股數／成本調整。',
  security_trade_managed: '這是股票管理交易，請由股票模式修改或刪除。',
  security_item_requires_trade: '證券科目必須由股票模式記帳。',
  recalculation_confirmation_required: '請先確認將重算的股票交易與損益變化。',
  preview_changed: '資料已變更，請重新預覽後確認。',
  invalid_sequence: '請輸入當日有效的交易順位。',
  market_data_invalid: '匯率／行情格式不正確，整批資料未寫入。',
  source_date_missing: '無法取得掛牌日期，請依檔名或明確填寫日期。',
  source_conflict: '來源有互相矛盾的重複資料，整批未寫入。',
  source_too_large: '來源檔案超過大小上限。',

  draft_amount_limit: '超過草稿的單筆本位幣上限，請調整金額後再核准。',
  draft_pending_limit: '這個帳本已有 50 筆待確認草稿，請先處理現有草稿。',
  draft_not_pending: '這筆草稿已處理，請重新載入清單。',
  draft_expired: '這筆草稿已超過 14 天或已到期，不能再核准。',
  insufficient_scope: '權杖未取得草稿權限，請由帳本擁有人建立草稿權杖。',
  currency_not_supported:
    '外幣卡片／貸款將於後續版本支援，請選擇帳本本位幣科目。',
  invalid_card_schedule:
    '繳款日須晚於結帳日；結帳日 28 日以後請選「次月繳款」。',
  finance_item_kind_invalid:
    '請確認信用卡／貸款科目與繳款、利息科目的類別設定。',
  budget_item_kind_invalid: '預算僅適用於收入或支出科目。',
  occurrence_not_pending: '這筆週期交易已入帳或略過，請重新載入清單。',
  worker_failed: '排程暫時無法完成，稍後會重試。',
  pat_limit_reached: '最多只能有 10 個有效權杖，請先撤銷舊權杖。',
  invalid_backup: '備份檔案格式不正確，包含未知欄位或資料型態不符。',
  backup_schema_unsupported:
    '目前不支援這個備份 schemaVersion，請使用相容版本。',
  backup_checksum_mismatch:
    '備份校驗碼不相符，檔案可能已損壞或被修改，不能還原。',
  backup_too_large: '備份最多 50 MiB、200,000 筆交易，請縮小檔案。',
  backup_count_mismatch: '備份列數與內容不符，請重新下載完整備份。',
  reference_invalid: '備份參照資料不完整或格式不正確，請檢查下方問題。',
  backup_invalid_data: '帳本資料不符合目前備份格式，請先檢查資料。',

  invalid_csv: 'CSV 格式不正確，請檢查引號、欄位與檔案大小。',
  invalid_csv_header: 'CSV 表頭必須與 Life2023 的 8 個欄位及順序完全相同。',
  csv_row_limit: 'CSV 必須有 1～10,000 筆資料。',
  encoding_required:
    '無法無損判定編碼，請選擇 UTF-8 或 Big5（CP950）後重新預覽。',
  already_imported: '這個檔案已匯入過，請勿重複寫入。',
  import_has_errors: '預覽仍有錯誤列；請修正或明確選擇只匯入無錯誤的列。',
  no_importable_rows: '沒有可匯入的資料列，請先完成對應與錯誤修正。',
  conflicting_mapping: '同一新增科目的設定不一致，請統一兩個對應的類型與旗標。',

  period_range_too_large:
    '一次最多查詢 1,000 個時段，請縮短日期範圍或改用較粗的粒度。',
  invalid_cursor: '查詢條件或資料位置已變更，請重新查詢。',
  unbalanced: '本位幣借貸尚未平衡，請核對每筆分錄金額。',
  fx_residual_exceeds_tolerance:
    '匯兌尾差超過可分攤範圍，請調整金額／匯率，或自行加入匯兌損益分錄。',
  base_amount_rounds_to_zero: '金額換算成本位幣後為 0，請調整原幣金額或匯率。',
  invalid_money_entry:
    '金額或匯率格式不正確；金額不可為 0，本位幣最多 2 位、外幣最多 6 位小數。',
  exchange_rate_missing: '沒有當日參考匯率，請手動填寫外幣匯率。',
  parent_item_not_postable: '大類別不能直接記帳，請選擇子科目。',
  archived_resource:
    '已封存的科目、收付人或專案不能新增使用；既有封存分錄須保留原金額。',
  item_ledger_mismatch: '科目不屬於目前帳本，請重新選擇。',
  payee_ledger_mismatch: '收付人不屬於目前帳本，請重新選擇。',
  project_ledger_mismatch: '專案不屬於目前帳本，請重新選擇。',
  unlock_confirmation_required:
    '往前移動或清除關帳日需要再次確認，請重新檢查關帳範圍。',
  period_locked:
    '交易日期位於已關帳期間，不能新增、修改或刪除；也不能將既有關帳交易移出該期間。',

  parent_kind_mismatch: '父科目與子科目必須使用相同類型；幣別可以不同。',
  invalid_input: '請檢查欄位格式與範圍；日期起訖與金額上下限須正確。',
  duplicate_name: '這個名稱已存在，請使用其他名稱。',
  ledger_not_empty: '帳本已有資料，不能刪除或變更本位幣。',
  not_found: '找不到資料，請重新整理。',
  unauthorized: '登入已逾時，請重新登入。',
  in_use: '資料已被使用，請改用封存。',
  origin_denied: '請從原網站重新操作。',
};
export const apiErrorMessage = (code?: string) =>
  messages[code ?? ''] ?? '操作失敗，請稍後再試。';
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    const data: { error?: string; details?: Record<string, unknown> } =
      await response.json().catch(() => ({}));
    throw Object.assign(new Error(apiErrorMessage(data.error)), {
      code: data.error,
      details: data.details,
    });
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '無法連線，請稍後再試。';
