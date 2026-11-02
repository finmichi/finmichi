// SPDX-License-Identifier: AGPL-3.0-only
export const resetErrors = {
  backup_token_required: '請先預覽並下載這次操作所需的全部 JSON 備份。',
  backup_token_invalid:
    '備份授權已失效、逾時或不屬於這次操作，請重新預覽及下載。',
  backup_required: '尚未產生全部帳本的 JSON 備份，不能刪除。',
  reauth_required: '請重新登入；刪除前的身分驗證須在 5 分鐘內完成。',
  reauth_identity_mismatch: '重新登入的帳號不同，請使用原本帳號重試。',
  confirmation_mismatch: '確認文字不符，請逐字輸入指定文字。',
  browser_session_required: '這項操作僅限瀏覽器登入，不能使用存取權杖或 MCP。',
  reset_rate_limited: '每位使用者 10 分鐘內只能刪除或重置一次，請稍後再試。',
  deletion_schema_incomplete:
    '資料表清單尚未完整分類，為保護資料已停止刪除，請聯絡維護者。',
};
export const resetLabels: Record<string, string> = {
  ledgers: '帳本',
  items: '科目',
  transactions: '交易',
  transaction_entries: '分錄',
  payees: '收付人',
  projects: '專案',
  memo_templates: '常用摘要',
  securities: '證券',
  security_trades: '股票紀錄',
  manual_prices: '手動價格',
  income_codes: '所得代碼',
  dividends: '股利',
  dividend_components: '股利組成',
  fixed_deposits: '定存',
  deposit_postings: '定存入帳紀錄',
  recurring_rules: '週期規則',
  recurring_occurrences: '週期當期',
  recurring_worker_runs: '週期排程狀態',
  budgets: '預算',
  transaction_drafts: 'AI 草稿',
  exchange_rates: '帳本匯率',
  import_jobs: '匯入工作',
  import_source_records: '來源紀錄',
  credit_card_settings: '信用卡設定',
  loan_settings: '貸款設定',
  reminder_settings: '提醒設定',
  reminder_reads: '提醒已讀紀錄',
  personal_access_tokens: '存取權杖',
  sessions: '其他登入狀態',
  data_reset_grants: '本次備份授權',
};
export const resetText = {
  purge: '刪除帳本與全部資料',
  factory: '原廠重置',
  irreversible: '這個動作無法復原',
  backupNotice:
    '操作前請先在 NAS 執行一次任務 A（資料庫備份），並完成下方 JSON 下載。',
  exclusions:
    'JSON 備份不包含 AI 草稿、存取權杖、其他登入狀態與排程執行狀態；這些資料刪除後無法由 JSON 還原。',
  retained: '保留使用者帳號、目前登入狀態、所有稽核紀錄及全站共用行情／匯率。',
};
