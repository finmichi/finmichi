// SPDX-License-Identifier: AGPL-3.0-only
import { encodeCsv, csvNumber as n, type CsvValue } from './csv.js';
import type { BalanceReport } from './report-schemas.js';
export function balanceReportCsv(r: BalanceReport) {
  const context = [r.as_of, r.generated_at];
  const rows: CsvValue[][] = [
    [
      '基準日',
      '產生時間',
      '區分',
      '科目',
      '本位幣',
      '自身帳面值',
      '含子科目帳面值',
      '科目幣別',
      '本科目原幣借貸餘額',
    ],
  ];
  for (const [name, key] of [
    ['資產合計', 'assets'],
    ['負債合計', 'liabilities'],
    ['淨值', 'net_worth'],
    ['權益合計', 'equity'],
    ['累積淨收支', 'net_income'],
    ['恆等式差額', 'identity_difference'],
  ] as const)
    rows.push([
      ...context,
      '總計',
      name,
      r.base_currency,
      n(r.totals[key]),
      '',
      '',
      '',
    ]);
  for (const i of r.items)
    rows.push([
      ...context,
      i.kind,
      i.name,
      r.base_currency,
      n(i.own_book_amount),
      n(i.book_amount),
      i.currency,
      n(i.own_original_amount),
    ]);
  return encodeCsv(rows);
}

export function incomeReportCsv(r: import('./report-schemas.js').IncomeReport) {
  const context = [r.date_from, r.date_to, r.grain, r.generated_at];
  const keys = [
    'operating_income',
    'non_operating_income',
    'operating_expense',
    'non_operating_expense',
    'income_total',
    'expense_total',
    'net_income',
  ] as const;
  const rows: CsvValue[][] = [
    [
      '期間起',
      '期間迄',
      '粒度',
      '產生時間',
      '時段',
      '時段起',
      '時段迄',
      '營業收入',
      '業外收入',
      '營業支出',
      '業外支出',
      '收入合計',
      '支出合計',
      '淨收支',
    ],
  ];
  for (const b of r.periods)
    rows.push([
      ...context,
      b.label,
      b.date_from,
      b.date_to,
      ...keys.map((k) => n(b[k])),
    ]);
  rows.push([
    ...context,
    '期間合計',
    r.date_from,
    r.date_to,
    ...keys.map((k) => n(r.totals[k])),
  ]);
  return encodeCsv(rows);
}

export function categoryReportCsv(
  r: import('./report-schemas.js').CategoryReport,
) {
  const context = [
    r.date_from,
    r.date_to,
    r.generated_at,
    r.kind,
    r.non_operating,
    r.fixed,
  ];
  const rows: CsvValue[][] = [
    [
      '期間起',
      '期間迄',
      '產生時間',
      '類別',
      '業外篩選',
      '固定性篩選',
      '科目',
      '父科目 id',
      '自身金額',
      '含子科目金額',
      '占比(%)',
    ],
    [...context, '期間總額', '', n(r.total_amount), n(r.root_amount), ''],
  ];
  for (const i of r.items)
    rows.push([
      ...context,
      i.name,
      i.parent_id ?? '',
      n(i.own_amount),
      n(i.rollup_amount),
      i.percentage === null ? '' : n(i.percentage),
    ]);
  return encodeCsv(rows);
}

export function budgetReportCsv(r: import('./report-schemas.js').BudgetReport) {
  const rows: CsvValue[][] = [
    [
      '年度',
      '粒度',
      '類別',
      '業外',
      '固定性',
      '時段',
      '科目',
      '父科目 id',
      '自身預算',
      '含子科目預算',
      '實際',
      '差異',
      '達成率(%)',
    ],
  ];
  for (const p of r.periods) {
    const ctx = [
      String(r.year),
      r.grain,
      r.kind,
      r.non_operating,
      r.fixed,
      p.label,
    ];
    rows.push([
      ...ctx,
      '時段合計',
      '',
      '',
      n(p.budget_total),
      n(p.actual_total),
      n(p.variance),
      p.achievement === null ? '' : n(p.achievement),
    ]);
    for (const i of p.items)
      rows.push([
        ...ctx,
        i.name,
        i.parent_id ?? '',
        n(i.budget_own),
        n(i.budget_rollup),
        n(i.actual_rollup),
        n(i.variance),
        i.achievement === null ? '' : n(i.achievement),
      ]);
  }
  rows.push([
    String(r.year),
    r.grain,
    r.kind,
    r.non_operating,
    r.fixed,
    '全年',
    '全年合計',
    '',
    '',
    n(r.totals.budget_total),
    n(r.totals.actual_total),
    n(r.totals.variance),
    r.totals.achievement === null ? '' : n(r.totals.achievement),
  ]);
  return encodeCsv(rows);
}

export function profitLossCsv(
  r: import('./report-schemas.js').ProfitLossReport,
) {
  const rows: CsvValue[][] = [
    ['區段', '科目', ...r.periods.map((p) => p.label), '合計'],
  ];
  const labels = {
    operating_income: '營業收入',
    operating_expense: '營業支出',
    non_operating_income: '業外收入',
    non_operating_expense: '業外支出',
  };
  for (const s of r.sections) {
    rows.push([
      labels[s.key],
      '小計',
      ...r.periods.map((p) => n(p[s.key])),
      n(r.totals[s.key]),
    ]);
    for (const i of s.items)
      rows.push([labels[s.key], i.name, ...i.amounts.map(n), n(i.total)]);
  }
  for (const [key, label] of [
    ['fixed_expense', '其中固定性'],
    ['variable_expense', '其中變動'],
    ['operating_profit', '營業損益'],
    ['non_operating_profit', '業外損益'],
    ['net_income', '本期損益'],
    ['operating_margin', '營業利益率(%)'],
  ] as const)
    rows.push([
      label,
      '',
      ...r.periods.map((p) => (p[key] === null ? '' : n(p[key]!))),
      r.totals[key] === null ? '' : n(r.totals[key]!),
    ]);
  return encodeCsv(rows);
}
export function netWorthFlowCsv(
  r: import('./report-schemas.js').NetWorthFlowReport,
) {
  return encodeCsv([
    ['時段', '期初淨值', '收入', '支出', '權益變動', '期末淨值', '恆等式差額'],
    ...r.periods.map((p) => [
      p.label,
      ...(
        [
          'opening',
          'income',
          'expense',
          'equity_change',
          'closing',
          'identity_difference',
        ] as const
      ).map((k) => n(p[k])),
    ]),
  ]);
}
export function accountLedgerCsv(
  r: import('./report-schemas.js').AccountLedgerReport,
) {
  return encodeCsv([
    [
      '日期',
      '摘要',
      '科目',
      '對方科目',
      '幣別',
      '流入',
      '流出',
      '原幣',
      '匯率',
      '本位幣',
      '原幣累計',
      '本位幣累計',
    ],
    ...r.items.map((i) => [
      i.occurred_on,
      i.memo,
      i.item_name,
      i.counterpart,
      i.currency,
      ...(
        [
          'inflow',
          'outflow',
          'amount',
          'exchange_rate',
          'base_amount',
          'original_balance',
          'book_balance',
        ] as const
      ).map((k) => n(i[k])),
    ]),
  ]);
}
