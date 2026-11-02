// SPDX-License-Identifier: AGPL-3.0-only
import type { CardsResult } from '@finmichi/core';
import { cardConvertedAmount } from '@finmichi/core/card-fx';
import type { TransactionInput } from '@finmichi/core/transaction-schemas';
import type {
  CardSettings,
  LoanSettings,
} from '@finmichi/core/finance-schemas';
import type { LoanPeriod } from '@finmichi/core/finance-calendar';
import { cardPeriod } from '@finmichi/core/finance-calendar';
import { units } from './design/display-math';
export function cardPaymentReason(s: CardSettings, unpaid: string) {
  return !s.payment_account_id
    ? '請先設定繳款帳戶'
    : units(unpaid) <= 0n
      ? '已繳清，無需繳款'
      : null;
}
export function paymentInput(
  entries: TransactionInput['entries'],
  date: string,
): TransactionInput {
  return {
    occurred_on: date,
    memo: '',
    invoice_no: '',
    payee_id: null,
    project_id: null,
    entries: entries
      .filter((e) => units(e.amount) !== 0n)
      .map((e) => ({ ...e, amount: normalizePaymentAmount(e.amount) })),
  };
}
export function loanPayment(s: LoanSettings, row: LoanPeriod, date: string) {
  return paymentInput(
    [
      { item_id: s.payment_account_id, amount: '-' + row.payment },
      { item_id: s.item_id, amount: row.principal },
      { item_id: s.interest_item_id, amount: row.interest },
    ],
    date,
  );
}

// Keep the exact decimal value; trim only insignificant fractional zeros.
export function normalizePaymentAmount(value: string): string {
  return value.includes('.')
    ? value.replace(/0+$/, '').replace(/\.$/, '')
    : value;
}
export function recentLoanPeriods(schedule: LoanPeriod[], asOf: string) {
  const next = schedule.findIndex((r) => r.due_on > asOf);
  const start =
    next < 0 ? Math.max(0, schedule.length - 1) : Math.max(0, next - 1);
  return schedule.slice(start, start + 2);
}
export function cardNextDates(
  card: CardSettings & {
    next_due: string;
    next_close: string;
    bills: { due_on: string; to: string }[];
  },
) {
  const close =
    card.bills.find((b) => b.due_on === card.next_due)?.to ??
    cardPeriod(card, card.next_close).to;
  return `下次繳款 ${card.next_due}（${close.slice(5)} 帳單）・下次結帳 ${card.next_close}`;
}

export function foreignCardPayment(
  c: CardsResult['cards'][number],
  unpaid: string,
  date: string,
) {
  const cross = c.payment_currency !== c.currency,
    quote = c.payment_quote;
  const amount = cross
    ? quote
      ? cardConvertedAmount(unpaid, quote.rate)
      : ''
    : unpaid;
  const input: TransactionInput = {
    occurred_on: date,
    memo: '',
    invoice_no: '',
    payee_id: null,
    project_id: null,
    entries: [
      {
        item_id: c.payment_account_id!,
        amount: amount ? '-' + normalizePaymentAmount(amount) : '',
      },
      { item_id: c.item_id, amount: normalizePaymentAmount(unpaid) },
    ],
  };
  const source =
    quote?.source === 'ledger'
      ? '帳本匯率'
      : quote?.source === 'bot-cross'
        ? '交叉匯率（臺銀）'
        : '臺銀即期賣出';
  return {
    input,
    mode: cross ? ('advanced' as const) : ('transfer' as const),
    notice: cross
      ? quote
        ? `預估匯率 ${quote.rate}（${source}，${quote.rate_date}），請依實際扣款修改。`
        : '缺少預估匯率，請填寫本位幣實際扣款金額。'
      : undefined,
  };
}
