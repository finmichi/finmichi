// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic-only fixture: one valid row in every ledger-owned table.
import { createHash } from 'node:crypto';
import {
  itemService,
  namedRecordService,
  transactionService,
  recurringService,
  budgetService,
  securityService,
  dividendService,
  depositService,
  patService,
  draftService,
} from '../packages/core/dist/index.js';
export async function seedDeletionLedger(db, actor, ledger) {
  const items = itemService(db),
    ids = {};
  for (const [key, kind, extra] of [
    ['cash', 'asset', {}],
    ['food', 'expense', {}],
    ['income', 'income', {}],
    ['holding', 'asset', { securities: true }],
    ['deposit', 'asset', {}],
    ['card', 'liability', { credit_card: true }],
    ['loan', 'liability', { loan: true }],
    ['gain', 'income', { non_operating: true }],
  ])
    ids[key] = (
      await items.create(actor, ledger, {
        name: '合成刪除測試 ' + key,
        kind,
        currency: 'TWD',
        ...extra,
      })
    ).id;
  const payee = await namedRecordService(db, 'payees').create(actor, ledger, {
      name: '合成收付人',
    }),
    project = await namedRecordService(db, 'projects').create(actor, ledger, {
      name: '合成專案',
    });
  await namedRecordService(db, 'memo_templates').create(actor, ledger, {
    name: '合成常用摘要',
    memo: 'SYNTHETIC_RESET_MEMO',
  });
  const template = {
    memo: 'SYNTHETIC_RESET_MEMO',
    payee_id: payee.id,
    project_id: project.id,
    entries: [
      { item_id: ids.cash, amount: '-100' },
      { item_id: ids.food, amount: '100' },
    ],
  };
  const tx = await transactionService(db).create(actor, ledger, {
    occurred_on: '2026-10-05',
    ...template,
  });
  await db`INSERT INTO exchange_rates(ledger_id,rate_date,from_currency,to_currency,rate) VALUES (${ledger},'2026-10-05','USD','TWD','32.5')`;
  const sha = createHash('sha256')
    .update('synthetic-reset-source-' + ledger)
    .digest('hex');
  const [job] =
    await db`INSERT INTO import_jobs(ledger_id,source_sha256,source_system,status) VALUES (${ledger},${sha},'emoney-mdb','imported') RETURNING id`;
  await db`INSERT INTO import_source_records(ledger_id,import_job_id,source_table,source_key,target_table,target_id) VALUES (${ledger},${job.id},'MYMONEY_DATA','synthetic-key','transactions',${tx.id})`;
  const recurring = recurringService(db);
  await recurring.save(actor, ledger, {
    name: '合成週期規則',
    frequency: 'monthly',
    day_of_month: 5,
    start_on: '2026-10-01',
    template,
  });
  await recurring.generate(actor, ledger, new Date('2026-10-06T04:00:00Z'));
  await db`INSERT INTO recurring_worker_runs(ledger_id,status) VALUES (${ledger},'success')`;
  await budgetService(db).distribute(actor, ledger, {
    year: 2026,
    item_id: ids.food,
    total: '1200.06',
  });
  await db`INSERT INTO credit_card_settings(item_id,ledger_id,statement_day,due_day,due_month_offset,payment_account_id,credit_limit) VALUES (${ids.card},${ledger},5,20,0,${ids.cash},'10000')`;
  await db`INSERT INTO loan_settings(item_id,ledger_id,principal,annual_rate,term_months,first_payment_on,method,payment_account_id,interest_item_id) VALUES (${ids.loan},${ledger},'1000','2',12,'2026-10-15','annuity',${ids.cash},${ids.food})`;
  const pats = patService(db),
    pat = await pats.create(actor, {
      scope: 'draft',
      expires_in_days: 1,
      ledger_ids: [ledger],
    });
  await draftService(db).create(
    await pats.authenticate(pat.token),
    ledger,
    { occurred_on: '2026-10-05', ...template },
    'SYNTHETIC_RESET_DRAFT',
  );
  const ds = dividendService(db),
    { disclaimer: _, ...defaults } = await ds.initialize(actor, ledger);
  void _;
  const stocks = securityService(db),
    security = await stocks.create(actor, ledger, {
      symbol: 'ZZZ9',
      name: '合成證券',
      market: 'TWSE',
      kind: 'stock',
      item_id: ids.holding,
    });
  const trade = {
    trade_type: 'buy',
    trade_date: '2026-01-01',
    quantity: '10',
    price: '10',
    fee: '0',
    tax: '0',
    settlement_item_id: ids.cash,
    expense_item_id: defaults.expense_item_id,
    gain_item_id: ids.gain,
  };
  const stockPreview = await stocks.preview(actor, ledger, security.id, {
    operation: 'create',
    trade,
  });
  const stock = await stocks.apply(actor, ledger, security.id, 'create', {
    trade,
    preview_hash: stockPreview.preview_hash,
    confirm_recalculation: true,
  });
  await stocks.price(actor, ledger, {
    market: 'TWSE',
    symbol: 'ZZZ9',
    price_date: '2026-10-05',
    price: '11',
  });
  const dividend = {
    security_id: security.id,
    ex_date: '2026-10-01',
    pay_date: '2026-10-15',
    shares: '10',
    per_share: '0.2',
    gross_amount: '2',
    net_amount: '2',
    settlement_item_id: ids.cash,
    ...defaults,
    components: [
      { code: '54C', label: '合成組成', amount: '2', taxable: true },
    ],
  };
  const dv = await ds.preview(actor, ledger, { operation: 'create', dividend });
  const dividendRow = await ds.apply(actor, ledger, 'create', {
    dividend,
    preview_hash: dv.preview_hash,
    confirm_recalculation: true,
  });
  const deposits = depositService(db),
    deposit = await deposits.save(actor, ledger, {
      item_id: ids.deposit,
      bank: '合成銀行',
      principal: '1000',
      annual_rate: '12',
      start_on: '2026-01-01',
      maturity_on: '2026-02-01',
      interest_basis: 'monthly',
      payout: 'monthly',
      payout_account_id: ids.cash,
      interest_item_id: defaults.default_income_item_id,
    });
  const amounts = {
    period_no: 1,
    posted_on: '2026-02-01',
    gross_interest: '10',
    withholding_tax: '0',
    nhi_premium: '0',
    renew: 'none',
  };
  const dp = await deposits.preview(actor, ledger, deposit.id, {
    operation: 'interest',
    amounts,
  });
  const posting = await deposits.apply(actor, ledger, deposit.id, 'interest', {
    ...amounts,
    preview_hash: dp.preview_hash,
  });
  await db`INSERT INTO reminder_settings(ledger_id) VALUES (${ledger})`;
  await db`INSERT INTO reminder_reads(ledger_id,key,fingerprint) VALUES (${ledger},${'deposit:' + deposit.id},${createHash('sha256').update('synthetic-read').digest('hex')})`;
  return {
    ids,
    pat,
    tx,
    security,
    stock,
    dividend: dividendRow,
    deposit,
    posting,
    project,
  };
}
