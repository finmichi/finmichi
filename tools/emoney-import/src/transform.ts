// SPDX-License-Identifier: AGPL-3.0-only
import {
  canonicalJson,
  calculateImportBaseAmounts,
  MoneyError,
  moneyUnits,
  formatMoney,
  sumMoney,
  roundHalfUp,
} from '@finmichi/core';
import { type Bundle, sha256 } from './bundle.js';
import {
  ImportError,
  type Mapping,
  type Plan,
  type Item,
  type Row,
  dateSchema,
} from './schema.js';
export const normalized = (s: string) => s.trim().toLowerCase();
const keyOf = (kind: string, name: string) =>
  JSON.stringify([kind, normalized(name)]);
const classes: Record<string, { kind: Item['kind']; non_operating: boolean }> =
  Object.fromEntries(
    [
      ['資產', 'asset', false],
      ['負債', 'liability', false],
      ['收入', 'income', false],
      ['業外收入', 'income', true],
      ['支出', 'expense', false],
      ['業外支出', 'expense', true],
    ].map(([name, kind, non_operating]) => [name, { kind, non_operating }]),
  ) as Record<string, { kind: Item['kind']; non_operating: boolean }>;
const currencies: Record<string, string> = {
  '': 'TWD',
  台幣: 'TWD',
  '台幣 (NTD)': 'TWD',
  新台幣: 'TWD',
  美元: 'USD',
  美金: 'USD',
  日幣: 'JPY',
  日圓: 'JPY',
  日元: 'JPY',
};
const own = <T>(o: Record<string, T>, k: string): T | undefined =>
  Object.hasOwn(o, k) ? o[k] : undefined;
export function sourceCurrency(
  note: string,
  overrides: Record<string, string> = {},
) {
  return own(overrides, note.trim()) ?? own(currencies, note.trim());
}
function number(value: string | undefined): string {
  if (value === undefined || value === '') return '0.000000';
  const s = value.trim();
  if (!s) throw new ImportError('invalid_amount');
  try {
    return formatMoney(moneyUnits(s));
  } catch {
    throw new ImportError('invalid_amount');
  }
}
function rate(value: string | undefined): string {
  const s = (value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,10})?$/.test(s) || !/[1-9]/.test(s))
    throw new ImportError('invalid_rate');
  return s;
}
function date(value: string): string | null {
  const s = value.trim();
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(s)) return null;
  const d = s.replaceAll('/', '-');
  return dateSchema.safeParse(d).success ? d : null;
}
function negate(s: string) {
  return formatMoney(-moneyUnits(s));
}
export function transform(
  bundle: Bundle,
  mapping: Mapping,
  mappingSha256: string | null,
  openingDate?: string,
): Plan {
  const report: Plan['report'] = {
    opening_ignored_totals: {},
    opening_balances: [],
    warnings: [],
    warning_counts: {},
    warning_details: [],
    errors: [],
    skipped: [],
    unknown_item_classes: {},
    unknown_currencies: {},
    missing_projects: {},
    kind_natural_totals: {},
    fx_rounding_count: 0,
    fx_rounding_total: '0.000000',
    unbalanced_total: '0.000000',
    single_leg_adjustment_count: 0,
    currency_leg_counts: {},
    parsed_only_counts: {},
  };
  const plan: Plan = {
    format: 'finmichi-emoney',
    schemaVersion: 1,
    source_sha256: bundle.sourceSha256,
    source_date: bundle.sourceDate,
    exported_at: bundle.exportedAt,
    mapping_sha256: mappingSha256,
    items: [],
    projects: [],
    payees: [],
    rates: [],
    transactions: [],
    staging: {},
    report,
  };
  const items = new Map<string, Item>(),
    sourceItems = new Map<string, Item>(),
    parents = new Map<string, string>(),
    table = (name: string) => bundle.tables.get(name) ?? [];
  const bookedTables = new Set([
    'ITEM_DATA',
    'MYMONEY_DATA',
    'PROJECT_SET',
    'SHOP_DATA',
    'CURRENCY_SET',
  ]);
  function warning(code: string, table: string, row: number, key = '') {
    if (!report.warnings.includes(code)) report.warnings.push(code);
    Object.defineProperty(report.warning_counts, code, {
      value: (own(report.warning_counts, code) ?? 0) + 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    report.warning_details.push({ code, table, row, key });
  }
  function issue(
    code: string,
    table: string,
    row: number,
    key = '',
    fatal = true,
    difference?: string,
  ) {
    if (!bookedTables.has(table)) {
      warning(
        code.startsWith('staging_') ? code : 'staging_' + code,
        table,
        row,
        key,
      );
      return;
    }
    const data = {
      code,
      table,
      row,
      key,
      ...(difference === undefined ? {} : { difference }),
    };
    (fatal ? report.errors : report.skipped).push(data);
  }
  function count(o: Record<string, number>, s: string) {
    Object.defineProperty(o, s, {
      value: (own(o, s) ?? 0) + 1,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  function designation(r: Row) {
    const c = (r.ITEM_CLASS ?? '').trim(),
      name = (r.ITEM_NOTE ?? '').trim();
    return (
      mapping.items.find((i) => i.item_class === c && i.item_note === name) ??
      own(mapping.item_classes, c) ??
      own(classes, c)
    );
  }
  function currency(note: string) {
    return sourceCurrency(note, mapping.currencies);
  }
  function addItem(item: Item) {
    const existing = items.get(item.key);
    if (existing) {
      if (
        existing.currency !== item.currency ||
        existing.non_operating !== item.non_operating
      )
        throw new ImportError('conflicting_item_mapping');
      existing.source_keys.push(...item.source_keys);
      return existing;
    }
    items.set(item.key, item);
    plan.items.push(item);
    return item;
  }
  function system(name: string, kind: 'equity' | 'income') {
    return addItem({
      key: keyOf(kind, name),
      name,
      kind,
      currency: 'TWD',
      parent_key: null,
      non_operating: kind === 'income',
      fixed: false,
      credit_card: false,
      loan: false,
      system_created: true,
      source_keys: [],
    });
  }
  // Currency mappings must refer to exact trimmed source identities, never fuzzy names.
  const sourceIdentities = new Set(
    table('ITEM_DATA').map((r) =>
      JSON.stringify([(r.ITEM_CLASS ?? '').trim(), (r.ITEM_NOTE ?? '').trim()]),
    ),
  );
  const itemCurrencies = new Map<string, string>();
  for (const entry of mapping.item_currencies) {
    const identity = JSON.stringify([entry.item_class, entry.item_note]);
    if (!sourceIdentities.has(identity))
      throw new ImportError('mapping_item_not_found');
    itemCurrencies.set(identity, entry.currency);
  }
  const ambiguousItems = new Map<string, { row: number; count: number }>();
  // Source identity is the trimmed source pair, independent of mapping and balances.
  const itemIdentities = new Set<string>();
  // ITEM_DATA is the sole authoritative currency source for account legs.
  table('ITEM_DATA').forEach((r, index) => {
    const c = (r.ITEM_CLASS ?? '').trim(),
      name = (r.ITEM_NOTE ?? '').trim(),
      note = (r.EXCHANGE_NOTE ?? '').trim(),
      d = designation(r),
      identity = JSON.stringify([c, name]),
      explicitCurrency = itemCurrencies.get(identity),
      ccy = explicitCurrency ?? currency(note),
      sourceRate = (r.EXCHANGE ?? '').trim(),
      ambiguous =
        !explicitCurrency &&
        ccy === 'TWD' &&
        (d?.kind === 'asset' || d?.kind === 'liability') &&
        sourceRate !== '' &&
        !/^1(?:\.0+)?$/.test(sourceRate),
      sourceKey = String(index + 1);
    if (ambiguous) {
      const existing = ambiguousItems.get(identity);
      if (existing) existing.count++;
      else ambiguousItems.set(identity, { row: index + 1, count: 1 });
    }
    if (itemIdentities.has(identity)) {
      issue('duplicate_item_identity', 'ITEM_DATA', index + 1);
      return;
    }
    itemIdentities.add(identity);
    if (explicitCurrency === 'TWD' && sourceRate !== '')
      warning(
        'item_rate_ignored_base_currency',
        'ITEM_DATA',
        index + 1,
        identity,
      );
    if (!d) {
      count(report.unknown_item_classes, c);
      issue('unknown_item_class', 'ITEM_DATA', index + 1, c);
    }
    if (!ccy) {
      count(report.unknown_currencies, note);
      issue('unknown_currency', 'ITEM_DATA', index + 1, note);
    }
    if (!name) {
      issue('invalid_item', 'ITEM_DATA', index + 1);
      return;
    }
    try {
      number(r.BEFORE_MOUNT);
    } catch {
      issue('invalid_amount', 'ITEM_DATA', index + 1, sourceKey);
    }
    if (!d || !ccy || ambiguous) return;
    const key = keyOf(d.kind, name),
      i = addItem({
        key,
        name,
        kind: d.kind,
        currency: ccy,
        parent_key: null,
        non_operating: d.non_operating,
        fixed: false,
        credit_card: d.kind === 'liability' && /信用卡/.test(name),
        loan: d.kind === 'liability' && /貸款/.test(name),
        system_created: false,
        source_keys: [sourceKey],
      });
    const source = JSON.stringify([c, normalized(name)]);
    if (sourceItems.has(source))
      issue('duplicate_source_item', 'ITEM_DATA', index + 1, sourceKey);
    else sourceItems.set(source, i);
    const parent = (r.PARENT_NOTE ?? '').trim();
    if (parent && normalized(parent) !== normalized(name))
      parents.set(key, keyOf(d.kind, parent));
  });
  for (const [key, { row, count }] of ambiguousItems)
    report.errors.push({
      code: 'ambiguous_item_currency',
      table: 'ITEM_DATA',
      row,
      key,
      count,
    });
  for (const [key, parent] of parents) {
    if (!items.has(parent)) issue('parent_item_missing', 'ITEM_DATA', 0, key);
    else items.get(key)!.parent_key = parent;
  }
  for (const item of items.values()) {
    const visited = new Set<string>();
    let cursor: Item | undefined = item;
    while (cursor) {
      if (visited.has(cursor.key)) {
        issue('item_cycle', 'ITEM_DATA', 0, item.key);
        break;
      }
      visited.add(cursor.key);
      cursor = cursor.parent_key ? items.get(cursor.parent_key) : undefined;
    }
  }
  const projects = new Map<string, string>(),
    payees = new Map<string, string>();
  table('PROJECT_SET').forEach((r, i) => {
    const key = (r.PROJECT_ID ?? '').trim(),
      name = (r.PROJECT_NOTE ?? '').trim();
    if (!key || !name || projects.has(key)) {
      issue('invalid_project', 'PROJECT_SET', i + 1, key);
      return;
    }
    projects.set(key, name);
    plan.projects.push({ key, name });
  });
  function payee(name: string) {
    const key = normalized(name);
    if (key && !payees.has(key)) {
      payees.set(key, name.trim());
      plan.payees.push({ key, name: name.trim() });
    }
    return key || null;
  }
  for (const r of table('SHOP_DATA')) {
    if (r.BUSINESS_NAME?.trim()) payee(r.BUSINESS_NAME);
    if (r.PROD_NAME?.trim()) payee(r.PROD_NAME);
  }
  table('CURRENCY_SET').forEach((r, index) => {
    const note = (r.CURRENCY_NOTE ?? '').trim(),
      ccy = currency(note);
    if (!ccy) {
      count(report.unknown_currencies, note);
      issue('unknown_currency', 'CURRENCY_SET', index + 1, note);
      return;
    }
    const supplied = r.RATE_DATE ?? r.EXCHANGE_DATE ?? r.DATA_DATE,
      day =
        supplied === undefined || !supplied.trim()
          ? bundle.sourceDate
          : date(supplied);
    if (!day) {
      issue('invalid_date', 'CURRENCY_SET', index + 1, note, false);
      return;
    }
    try {
      const value = rate(r.CURRENCY_EXCHANGE);
      if (ccy === 'TWD' && moneyUnits(value) !== 1000000n)
        throw new ImportError('invalid_rate');
      const key = `${day}|${ccy}|TWD`;
      if (plan.rates.some((x) => x.key === key))
        throw new ImportError('duplicate_rate');
      plan.rates.push({
        key,
        rate_date: day,
        from_currency: ccy,
        to_currency: 'TWD',
        rate: value,
        as_of_source: !supplied?.trim(),
      });
    } catch (e) {
      issue(
        e instanceof ImportError ? e.code : 'invalid_rate',
        'CURRENCY_SET',
        index + 1,
        note,
      );
    }
  });
  const groups = new Map<string, { row: Row; index: number }[]>();
  table('MYMONEY_DATA').forEach((row, i) => {
    const key =
      row.DATA_KEY?.trim() || `fallback:${row.MAKE_NO2?.trim() ?? ''}:${i + 1}`;
    const group = groups.get(key) ?? [];
    group.push({ row, index: i + 1 });
    groups.set(key, group);
  });
  for (const [key, group] of groups) {
    let invalid = false;
    const entries: {
        itemId: string;
        amount: string;
        currency: string;
        exchangeRate: string;
      }[] = [],
      entrySources: string[][] = [];
    const days = new Set<string>(),
      projectKeys = new Set<string>(),
      payeeKeys = new Set<string>(),
      memos: string[] = [];
    for (const { row: r, index } of group) {
      const day = date(r.DATA_DATE ?? '');
      if (!day) {
        issue('invalid_date', 'MYMONEY_DATA', index, key, false);
        invalid = true;
      } else days.add(day);
      const project = (r.PROJECT_ID ?? '').trim();
      if (project) {
        projectKeys.add(project);
        if (!projects.has(project)) {
          count(report.missing_projects, project);
          issue('missing_project', 'MYMONEY_DATA', index, key, false);
          invalid = true;
        }
      }
      const name = (r.PAY_COLL_NAME ?? '').trim();
      if (name) payeeKeys.add(payee(name)!);
      for (const memo of [r.DATA_NOTE, r.DATA_NOTE2])
        if (memo && !memos.includes(memo)) memos.push(memo);
      let amount: string;
      try {
        amount = formatMoney(
          moneyUnits(number(r.IN_MOUNT)) - moneyUnits(number(r.OUT_MOUNT)),
        );
      } catch {
        issue('invalid_amount', 'MYMONEY_DATA', index, key);
        invalid = true;
        continue;
      }
      if (moneyUnits(amount) === 0n) {
        issue('zero_amount', 'MYMONEY_DATA', index, key, false);
        continue;
      }
      const className = (r.ITEM_CLASS ?? '').trim();
      if (!designation(r)) {
        count(report.unknown_item_classes, className);
        issue('unknown_item_class', 'MYMONEY_DATA', index, className);
        invalid = true;
      }
      const item = sourceItems.get(
        JSON.stringify([className, normalized(r.ITEM_NOTE ?? '')]),
      );
      if (!item) {
        issue('no_item_leg', 'MYMONEY_DATA', index, key, false);
        invalid = true;
        continue;
      }
      const supplied = r.EXCHANGE?.trim();
      let exchangeRate = '1';
      try {
        if (item.currency !== 'TWD') {
          const fallback = plan.rates.find(
            (x) => x.rate_date === day && x.from_currency === item.currency,
          )?.rate;
          exchangeRate = rate(supplied || fallback);
          if (roundHalfUp(exchangeRate, 10) === '1.0000000000')
            warning('foreign_leg_rate_one', 'MYMONEY_DATA', index, key);
        } else if (supplied) {
          // A base-currency leg is already denominated in TWD. Source rates are metadata only.
          let isOne = false;
          try {
            isOne =
              rate(supplied) !== '' &&
              roundHalfUp(supplied, 10) === '1.0000000000';
          } catch {
            /* even malformed base reference rates are ignored */
          }
          if (!isOne)
            warning('source_rate_ignored_base_leg', 'MYMONEY_DATA', index, key);
        }
      } catch {
        issue('invalid_rate', 'MYMONEY_DATA', index, key);
        invalid = true;
        continue;
      }
      entries.push({
        itemId: item.key,
        amount,
        currency: item.currency,
        exchangeRate,
      });
      entrySources.push([String(index)]);
      count(report.currency_leg_counts, item.currency);
    }
    if (invalid) continue;
    if (days.size !== 1 || projectKeys.size > 1 || payeeKeys.size > 1) {
      issue('conflicting_group', 'MYMONEY_DATA', group[0]!.index, key);
      continue;
    }
    if (!entries.length) {
      issue('no_item_leg', 'MYMONEY_DATA', group[0]!.index, key, false);
      continue;
    }
    const single = entries.length === 1;
    try {
      if (single) {
        const first = entries[0]!,
          counter = system('期初／調整', 'equity');
        const rounded = roundHalfUp(
          exactProduct(first.amount, first.exchangeRate),
        );
        entries.push({
          itemId: counter.key,
          amount: negate(rounded),
          currency: 'TWD',
          exchangeRate: '1',
        });
        entrySources.push([]);
      }
      const calculated = calculateImportBaseAmounts(entries, 'TWD');
      const resultEntries = calculated.entries.map((e, i) => {
        let itemKey = e.itemId!;
        if (e.systemItem) {
          itemKey = system('匯兌尾差', 'income').key;
          report.fx_rounding_count++;
          report.fx_rounding_total = sumMoney([
            report.fx_rounding_total,
            e.amount,
          ]);
        }
        return {
          item_key: itemKey,
          amount: e.amount,
          currency: e.currency,
          exchange_rate: e.exchangeRate,
          base_amount: e.baseAmount,
          source_keys: entrySources[i] ?? [],
        };
      });
      const kinds = resultEntries.map((e) => items.get(e.item_key)!.kind),
        kind = single
          ? 'adjustment'
          : kinds.includes('income')
            ? 'income'
            : kinds.includes('expense')
              ? 'expense'
              : kinds.every((k) => k === 'asset' || k === 'liability')
                ? 'transfer'
                : 'adjustment';
      plan.transactions.push({
        source_key: key,
        occurred_on: [...days][0]!,
        memo: memos.join('\n'),
        kind,
        project_key: [...projectKeys][0] ?? null,
        payee_key: [...payeeKeys][0] ?? null,
        entries: resultEntries,
      });
      if (single) report.single_leg_adjustment_count++;
    } catch (e) {
      if (e instanceof MoneyError) {
        if (e.code === 'unbalanced') {
          const difference = sumMoney(
            entries.map((e) =>
              roundHalfUp(exactProduct(e.amount, e.exchangeRate)),
            ),
          );
          issue(
            'unbalanced',
            'MYMONEY_DATA',
            group[0]!.index,
            key,
            false,
            difference,
          );
          report.unbalanced_total = sumMoney([
            report.unbalanced_total,
            difference,
          ]);
        } else issue(e.code, 'MYMONEY_DATA', group[0]!.index, key);
      } else throw e;
    }
  }
  for (const t of plan.transactions)
    for (const e of t.entries) {
      const kind = items.get(e.item_key)!.kind,
        signed = ['income', 'liability', 'equity'].includes(kind)
          ? negate(e.base_amount)
          : e.base_amount;
      Object.defineProperty(report.kind_natural_totals, kind, {
        value: sumMoney([own(report.kind_natural_totals, kind) ?? '0', signed]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  if (
    ['income', 'expense'].some(
      (k) => moneyUnits(own(report.kind_natural_totals, k) ?? '0') < 0n,
    )
  )
    report.warnings.unshift('sign_convention_suspect');
  for (const name of ['REGULAR_DATA', 'STOCK_DATA', 'STOCK_ID_DATA']) {
    plan.staging[name] = table(name).map((r, index) => {
      const copy = { ...r };
      if (name === 'REGULAR_DATA') {
        const note = (r.CURRENCY_NOTE ?? '').trim(),
          ccy = currency(note);
        if (ccy) copy.currency = ccy;
        else {
          count(report.unknown_currencies, note);
          issue('unknown_currency', name, index + 1, note);
        }
      }
      for (const field of name === 'REGULAR_DATA'
        ? ['SAVE_MOUNT', 'PROFIT_RATIO']
        : name === 'STOCK_DATA'
          ? [
              'IN_QUANTY',
              'OUT_QUANTY',
              'INOUT_PRICE',
              'INOUT_CHARGE',
              'OUT_TAX',
            ]
          : ['NOW_PRICE'])
        if (r[field] !== undefined) {
          try {
            number(r[field]);
            if (
              (field === 'INOUT_PRICE' || field === 'NOW_PRICE') &&
              (r[field]!.trim().split('.')[1]?.length ?? 0) > 4
            )
              issue('precision_exceeds_supported', name, index + 1, field);
          } catch {
            issue('invalid_amount', name, index + 1, field);
          }
        }
      for (const field of name === 'REGULAR_DATA'
        ? ['START_DATE', 'END_DATE']
        : ['INOUT_DATE', 'PRICE_DATE'])
        if (r[field]?.trim()) {
          const d = date(r[field]);
          if (!d) issue('invalid_date', name, index + 1, field, false);
          else copy['parsed_' + field.toLowerCase()] = d;
        }
      if (name === 'STOCK_ID_DATA') {
        const raw = r.PRICE_DATE ?? r.DATA_DATE;
        copy.as_of_date = raw?.trim() ? (date(raw) ?? '') : bundle.sourceDate;
        copy.as_of_source = raw?.trim() ? 'false' : 'true';
        if (!copy.as_of_date)
          issue('invalid_date', name, index + 1, 'price', false);
      }
      return copy;
    });
    report.parsed_only_counts[name] = plan.staging[name]!.length;
  }
  // Explicit opening transactions, independent of dated single-leg adjustments (ADR0008 §5).
  const validDays = table('MYMONEY_DATA')
    .map((r) => date(r.DATA_DATE ?? ''))
    .filter((d): d is string => d !== null)
    .sort();
  const earliest = validDays[0],
    defaultDay = new Date(
      (earliest ??
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Taipei',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(bundle.exportedAt))) + 'T00:00:00Z',
    );
  defaultDay.setUTCDate(defaultDay.getUTCDate() - 1);
  const day = openingDate ?? defaultDay.toISOString().slice(0, 10);
  if (!dateSchema.safeParse(day).success)
    throw new ImportError('invalid_opening_date');
  if (earliest && day >= earliest)
    throw new ImportError('opening_date_after_first_transaction');
  const openingTransactions: Plan['transactions'] = [];
  table('ITEM_DATA').forEach((r, index) => {
    let amount: string;
    try {
      amount = number(r.BEFORE_MOUNT);
    } catch {
      return;
    }
    if (moneyUnits(amount) === 0n) return;
    const item = sourceItems.get(
      JSON.stringify([
        (r.ITEM_CLASS ?? '').trim(),
        normalized(r.ITEM_NOTE ?? ''),
      ]),
    );
    if (!item) return;
    const warnings: string[] = [],
      excluded = mapping.exclude_opening.includes(item.name);
    let base: string | null = null;
    if (!['asset', 'liability'].includes(item.kind)) {
      warnings.push('opening_ignored_non_balance_item');
      const ignoredKey = JSON.stringify([item.kind, item.currency]);
      Object.defineProperty(report.opening_ignored_totals, ignoredKey, {
        value: sumMoney([
          own(report.opening_ignored_totals, ignoredKey) ?? '0',
          amount,
        ]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else if (!excluded) {
      const single = plan.transactions.filter(
          (t) =>
            t.kind === 'adjustment' &&
            t.entries.length === 2 &&
            t.entries[0]!.item_key === item.key,
        ),
        firstDay = plan.transactions
          .filter((t) => t.entries.some((e) => e.item_key === item.key))
          .map((t) => t.occurred_on)
          .sort()[0];
      if (
        single.some(
          (t) =>
            moneyUnits(t.entries[0]!.amount) === moneyUnits(amount) &&
            t.occurred_on === firstDay,
        )
      )
        warnings.push('possible_duplicate_opening');
      try {
        const exchangeRate =
            item.currency === 'TWD'
              ? '1'
              : rate(own(mapping.opening_rates, item.name) ?? r.EXCHANGE),
          counter = system('期初／調整', 'equity');
        const calculated = calculateImportBaseAmounts([
          { itemId: item.key, amount, currency: item.currency, exchangeRate },
          {
            itemId: counter.key,
            amount: negate(roundHalfUp(exactProduct(amount, exchangeRate))),
            currency: 'TWD',
            exchangeRate: '1',
          },
        ]);
        base = calculated.entries[0]!.baseAmount;
        const sourceId = `${(r.ITEM_CLASS ?? '').trim()}|${(r.ITEM_NOTE ?? '').trim()}`;
        openingTransactions.push({
          source_key: `ITEM_DATA:${sourceId}:opening`,
          occurred_on: day,
          memo: 'E-Money 期初餘額',
          kind: 'adjustment',
          project_key: null,
          payee_key: null,
          entries: calculated.entries.map((e) => ({
            item_key: e.itemId!,
            amount: e.amount,
            currency: e.currency,
            exchange_rate: e.exchangeRate,
            base_amount: e.baseAmount,
            source_keys: [String(index + 1)],
          })),
        });
      } catch (e) {
        issue(
          e instanceof ImportError && e.code === 'invalid_rate'
            ? 'opening_rate_missing'
            : e instanceof ImportError || e instanceof MoneyError
              ? e.code
              : 'opening_invalid',
          'ITEM_DATA',
          index + 1,
          item.name,
        );
      }
    }
    report.opening_balances.push({
      item_key: item.key,
      name: item.name,
      kind: item.kind,
      currency: item.currency,
      amount,
      base_amount: base,
      occurred_on: day,
      warnings,
      excluded,
    });
    for (const warning of warnings)
      if (!report.warnings.includes(warning)) report.warnings.push(warning);
  });
  plan.transactions.unshift(...openingTransactions);
  report.kind_natural_totals = {};
  for (const t of plan.transactions)
    for (const e of t.entries) {
      const kind = items.get(e.item_key)!.kind,
        signed = ['income', 'liability', 'equity'].includes(kind)
          ? negate(e.base_amount)
          : e.base_amount;
      Object.defineProperty(report.kind_natural_totals, kind, {
        value: sumMoney([own(report.kind_natural_totals, kind) ?? '0', signed]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  for (const name of bundle.tables.keys())
    if (
      ![
        'ITEM_DATA',
        'MYMONEY_DATA',
        'PROJECT_SET',
        'SHOP_DATA',
        'CURRENCY_SET',
        'REGULAR_DATA',
        'STOCK_DATA',
        'STOCK_ID_DATA',
      ].includes(name)
    ) {
      plan.staging[name] = table(name);
      report.parsed_only_counts[name] = table(name).length;
    }
  validatePlanSourceKeys(plan);
  return plan;
}
// All planned transactions use source_system emoney-mdb. Do not log source-key contents.
export function validatePlanSourceKeys(
  plan: Pick<Plan, 'transactions' | 'report'>,
) {
  const counts = new Map<string, { count: number; table: string }>();
  for (const t of plan.transactions) {
    const pair = JSON.stringify(['emoney-mdb', t.source_key]);
    const found = counts.get(pair);
    if (found) found.count++;
    else
      counts.set(pair, {
        count: 1,
        table:
          t.source_key.startsWith('ITEM_DATA:') &&
          t.source_key.endsWith(':opening')
            ? 'ITEM_DATA'
            : 'MYMONEY_DATA',
      });
  }
  for (const { count, table } of counts.values())
    if (count > 1)
      plan.report.errors.push({
        code: 'duplicate_source_key',
        table,
        row: 0,
        key: '',
        count,
      });
}
// Exact decimal multiplication for import-only pairing diagnostics and single-leg counters.
export function exactProduct(amount: string, rate: string): string {
  const [whole, fraction = ''] = rate.split('.'),
    r = BigInt(whole! + fraction.padEnd(10, '0')),
    p = moneyUnits(amount) * r,
    n = p < 0n ? -p : p;
  return `${p < 0n ? '-' : ''}${n / 10000000000000000n}.${String(n % 10000000000000000n).padStart(16, '0')}`;
}
export function encodePlan(plan: Plan) {
  const payload = canonicalJson(plan);
  return (
    JSON.stringify({ payloadSha256: sha256(payload), plan }, null, 2) + '\n'
  );
}
