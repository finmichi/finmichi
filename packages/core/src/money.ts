// SPDX-License-Identifier: AGPL-3.0-only
// numeric(20,6) decimal strings; all monetary arithmetic uses BigInt.
const CENT_UNITS = 10_000n;
const RATE_SCALE = 10_000_000_000n;
const PRODUCT_PER_CENT = 100_000_000_000_000n;
const abs = (n: bigint) => (n < 0n ? -n : n);
const sign = (n: bigint) => (n < 0n ? -1n : n > 0n ? 1n : 0n);
function scaled(value: string, places: number): bigint {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^-?(?:0|[1-9]\\d{0,13})(?:\\.\\d{1,${places}})?$`).test(value)
  )
    throw new MoneyError('invalid_money_entry');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return (
    (negative ? -1n : 1n) *
    (BigInt(whole!) * 10n ** BigInt(places) +
      BigInt(fraction.padEnd(places, '0')))
  );
}
function fixed(value: bigint, places: number): string {
  const scale = 10n ** BigInt(places),
    n = abs(value);
  return `${value < 0n ? '-' : ''}${n / scale}.${String(n % scale).padStart(places, '0')}`;
}
function divideHalfUp(n: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError('invalid_money_entry');
  const a = abs(n);
  return (
    sign(n) *
    (a / denominator + ((a % denominator) * 2n >= denominator ? 1n : 0n))
  );
}
export class MoneyError extends Error {
  constructor(
    public readonly code:
      | 'invalid_money_entry'
      | 'unbalanced'
      | 'base_amount_rounds_to_zero'
      | 'fx_residual_exceeds_tolerance',
  ) {
    super(code);
    this.name = 'MoneyError';
  }
}
export function moneyUnits(value: string): bigint {
  return scaled(value, 6);
}
export function formatMoney(units: bigint): string {
  const value = fixed(units, 6);
  moneyUnits(value);
  return value;
}
export function sumMoney(values: readonly string[]): string {
  return formatMoney(
    values.reduce((sum, value) => sum + moneyUnits(value), 0n),
  );
}
export function assertBalanced(baseAmounts: readonly string[]): void {
  if (baseAmounts.length < 2 || sumMoney(baseAmounts) !== '0.000000')
    throw new MoneyError('unbalanced');
}
export function roundHalfUp(value: string, places: 2 | 10 = 2): string {
  if (
    typeof value !== 'string' ||
    value.length > 80 ||
    !/^-?\d+(?:\.\d+)?$/.test(value)
  )
    throw new MoneyError('invalid_money_entry');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const exact = (negative ? -1n : 1n) * BigInt(whole! + fraction);
  return fixed(
    divideHalfUp(exact * 10n ** BigInt(places), 10n ** BigInt(fraction.length)),
    places,
  );
}
export interface MoneyEntry {
  amount: string;
  currency: string;
  exchangeRate?: string;
  itemId?: string;
}
export interface CalculatedEntry extends MoneyEntry {
  exchangeRate: string;
  baseAmount: string;
  systemItem?: {
    name: '匯兌尾差';
    kind: 'income';
    nonOperating: true;
    systemCreated: true;
    sourceReason: 'fx_rounding_residual';
  };
}
export interface FxComparison {
  entryIndex: number;
  effectiveRate: string;
  referenceRate: string | null;
  deviationPercent: string | null;
}
export interface MoneyCalculation {
  entries: CalculatedEntry[];
  scenario: 'A' | 'C' | 'BD';
  fxComparisons: FxComparison[];
  warnings: { code: 'fx_rate_deviation'; entryIndex: number }[];
}
function prepare(entries: readonly MoneyEntry[], baseCurrency: string) {
  if (entries.length < 2 || !/^[A-Z]{3}$/.test(baseCurrency))
    throw new MoneyError('invalid_money_entry');
  return entries.map((entry, index) => {
    if (!/^[A-Z]{3}$/.test(entry.currency))
      throw new MoneyError('invalid_money_entry');
    const amount = moneyUnits(entry.amount);
    if (amount === 0n) throw new MoneyError('invalid_money_entry');
    const isBase = entry.currency === baseCurrency;
    const rate =
      entry.exchangeRate === undefined
        ? undefined
        : scaled(entry.exchangeRate, 10);
    if (rate !== undefined && rate <= 0n)
      throw new MoneyError('invalid_money_entry');
    if (
      isBase &&
      (amount % CENT_UNITS !== 0n ||
        (rate !== undefined && rate !== RATE_SCALE))
    )
      throw new MoneyError('invalid_money_entry');
    return {
      entry,
      index,
      amount,
      isBase,
      rate,
      cents: isBase ? amount / CENT_UNITS : 0n,
      exact: 0n,
    };
  });
}
function baseString(cents: bigint): string {
  const result = fixed(cents, 2);
  moneyUnits(result);
  return result;
}
export function calculateBaseAmounts(
  entries: readonly MoneyEntry[],
  baseCurrency = 'TWD',
): MoneyCalculation {
  const rows = prepare(entries, baseCurrency),
    foreign = rows.filter((r) => !r.isBase);
  const target = -rows
    .filter((r) => r.isBase)
    .reduce((sum, r) => sum + r.cents, 0n);
  const warnings: MoneyCalculation['warnings'] = [];
  const fxComparisons: FxComparison[] = [];
  let scenario: MoneyCalculation['scenario'] = 'A';
  if (foreign.length === 0) {
    if (target !== 0n) throw new MoneyError('unbalanced');
  } else if (foreign.length === 1 && foreign.length < rows.length) {
    scenario = 'C';
    const f = foreign[0]!;
    if (target === 0n) throw new MoneyError('base_amount_rounds_to_zero');
    if (sign(target) !== sign(f.amount))
      throw new MoneyError('invalid_money_entry');
    const effective = divideHalfUp(
      abs(target) * PRODUCT_PER_CENT,
      abs(f.amount),
    );
    if (effective <= 0n) throw new MoneyError('invalid_money_entry');
    fxComparisons.push({
      entryIndex: f.index,
      effectiveRate: fixed(effective, 10),
      referenceRate: f.rate === undefined ? null : fixed(f.rate, 10),
      deviationPercent:
        f.rate === undefined
          ? null
          : fixed(
              divideHalfUp(abs(effective - f.rate) * 100n * RATE_SCALE, f.rate),
              10,
            ),
    });
    // Persist the effective rate at 10 places. Reference rate is only a warning input.
    if (f.rate !== undefined && abs(effective - f.rate) * 100n > f.rate * 5n)
      warnings.push({ code: 'fx_rate_deviation', entryIndex: f.index });
    f.rate = effective;
    f.cents = target;
    scaled(fixed(effective, 10), 10); // numeric(24,10) bound.
  } else {
    scenario = 'BD';
    for (const f of foreign) {
      if (f.rate === undefined) throw new MoneyError('invalid_money_entry');
      f.exact = f.amount * f.rate;
      f.cents = divideHalfUp(f.exact, PRODUCT_PER_CENT);
      if (f.cents === 0n) throw new MoneyError('base_amount_rounds_to_zero');
    }
    const residual = target - foreign.reduce((sum, f) => sum + f.cents, 0n);
    let remaining = abs(residual);
    if (remaining > BigInt(foreign.length))
      throw new MoneyError('fx_residual_exceeds_tolerance');
    const direction = sign(residual);
    const sorted = [...foreign].sort((a, b) => {
      const aError = a.exact - a.cents * PRODUCT_PER_CENT,
        bError = b.exact - b.cents * PRODUCT_PER_CENT;
      if (aError !== bError)
        return aError < bError
          ? direction > 0n
            ? 1
            : -1
          : direction > 0n
            ? -1
            : 1;
      if (abs(a.exact) !== abs(b.exact))
        return abs(a.exact) > abs(b.exact) ? -1 : 1;
      return a.index - b.index;
    });
    for (const f of sorted) {
      if (remaining === 0n) break;
      const adjusted = f.cents + direction;
      if (adjusted === 0n || sign(adjusted) !== sign(f.amount)) continue;
      f.cents = adjusted;
      remaining -= 1n;
    }
    if (remaining !== 0n) throw new MoneyError('fx_residual_exceeds_tolerance');
  }
  const result = rows.map((r) => ({
    ...r.entry,
    exchangeRate: fixed(r.isBase ? RATE_SCALE : r.rate!, 10),
    baseAmount: baseString(r.cents),
  }));
  assertBalanced(result.map((r) => r.baseAmount));
  return { entries: result, scenario, warnings, fxComparisons };
}
// Import-only planning: preserves source amounts. The importer resolves the returned
// system item and persists sourceReason in import_source_records/report in one transaction.
export function calculateImportBaseAmounts(
  entries: readonly MoneyEntry[],
  baseCurrency = 'TWD',
): MoneyCalculation {
  const rows = prepare(entries, baseCurrency),
    foreign = rows.filter((r) => !r.isBase);
  let sum = 0n;
  for (const r of rows) {
    if (r.isBase) sum += r.cents;
    else {
      if (r.rate === undefined) throw new MoneyError('invalid_money_entry');
      const rounded = divideHalfUp(r.amount * r.rate, PRODUCT_PER_CENT);
      if (rounded === 0n) throw new MoneyError('base_amount_rounds_to_zero');
      sum += rounded;
    }
  }
  const residual = -sum;
  if (abs(residual) > 100n) throw new MoneyError('unbalanced');
  try {
    return calculateBaseAmounts(entries, baseCurrency);
  } catch (error) {
    if (
      !(error instanceof MoneyError) ||
      error.code !== 'fx_residual_exceeds_tolerance' ||
      abs(residual) <= BigInt(foreign.length)
    )
      throw error;
    const amount = baseString(residual);
    const result = calculateBaseAmounts(
      [...entries, { amount, currency: baseCurrency, exchangeRate: '1' }],
      baseCurrency,
    );
    result.entries[result.entries.length - 1]!.systemItem = {
      name: '匯兌尾差',
      kind: 'income',
      nonOperating: true,
      systemCreated: true,
      sourceReason: 'fx_rounding_residual',
    };
    return result;
  }
}
