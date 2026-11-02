// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import type { BalanceItem } from '@finmichi/core/report-schemas';
import {
  naturalOriginalAmount,
  balanceOriginalAmount,
} from './report-presentation';
describe('balance original-currency presentation', () => {
  it('reverses liability/equity, preserves signed assets and negative natural balances', () => {
    expect(naturalOriginalAmount('liability', '-799.123456')).toBe(
      '799.123456',
    );
    expect(naturalOriginalAmount('equity', '-10000.000000')).toBe(
      '10000.000000',
    );
    expect(naturalOriginalAmount('asset', '-20.123456')).toBe('-20.123456');
    expect(naturalOriginalAmount('liability', '10.000000')).toBe('-10.000000');
  });
  const row: BalanceItem = {
    id: 'synthetic',
    parent_id: null,
    name: '合成美元負債',
    kind: 'liability',
    currency: 'USD',
    archived: false,
    credit_card: true,
    loan: false,
    own_original_amount: '-20.000000',
    own_book_amount: '640.00',
    book_amount: '3200.00',
    original_balances: [
      {
        currency: 'USD',
        original_amount: '-100.000000',
        book_amount: '3200.00',
      },
    ],
  };
  it('uses same-currency subtree for parent original amounts, without reversing natural book values again', () => {
    expect(balanceOriginalAmount(row)).toBe('100.000000');
    expect(row.book_amount).toBe('3200.00');
    expect(row.own_original_amount).toBe('-20.000000');
  });
  it('falls back to own original only when no subtree currency exists', () => {
    expect(balanceOriginalAmount({ ...row, original_balances: [] })).toBe(
      '20.000000',
    );
  });
});
