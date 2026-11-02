// SPDX-License-Identifier: AGPL-3.0-only
const messages: Record<string, string> = {
  market_data_invalid: '來源資料格式不正確，整批資料未寫入。',
  source_date_missing: '來源資料缺少日期，無法更新行情。',
  source_conflict: '來源資料互相矛盾，整批資料未寫入。',
  source_too_large: '來源資料超過大小上限。',
  source_http_error: '行情來源回傳錯誤，請稍後重試。',
  redirect_forbidden: '行情來源要求重新導向，已停止連線。',
  source_timeout: '行情來源連線逾時，稍後會自動重試。',
  dns_failed: '無法解析行情來源網址，請檢查 DNS 或網路連線。',
  tls_failed: '行情來源的安全連線或憑證驗證失敗，請檢查憑證與系統時間。',
  connection_refused: '行情來源拒絕連線，請稍後重試或檢查網路設定。',
  source_unavailable: '行情來源暫時無法連線，稍後會自動重試。',
};
export const marketFailureMessage = (code: string | null) =>
  messages[code ?? ''] ?? '行情更新失敗，請依錯誤代碼聯絡維護者。';
