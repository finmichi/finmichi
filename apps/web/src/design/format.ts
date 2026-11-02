// SPDX-License-Identifier: AGPL-3.0-only
// Presentation only: decimal strings -> integer units. No amount passes through Number/float.
function rounded(
  input: string | null | undefined,
  places: number,
): { negative: boolean; whole: string; fraction: string } | null {
  if (
    typeof input !== 'string' ||
    input.length > 80 ||
    !/^-?\d+(?:\.\d+)?$/.test(input)
  )
    return null;
  const negative = input.startsWith('-');
  const [whole, fraction = ''] = (negative ? input.slice(1) : input).split('.');
  const digits = fraction.padEnd(places + 1, '0');
  let units =
    BigInt(whole!) * 10n ** BigInt(places) +
    BigInt(digits.slice(0, places) || '0');
  if (digits[places]! >= '5') units += 1n;
  const padded = units.toString().padStart(places + 1, '0');
  return {
    negative: negative && units !== 0n,
    whole: places ? padded.slice(0, -places) : padded,
    fraction: places ? padded.slice(-places) : '',
  };
}
export function formatMoney(
  input: string | null | undefined,
  currency = 'TWD',
  options: { compact?: boolean; sign?: 'auto' | 'always' } = {},
) {
  const v = rounded(input, 2);
  if (!v || !/^[A-Z]{3}$/.test(currency)) return '—';
  const sign = v.negative
    ? '−'
    : options.sign === 'always' && (v.whole !== '0' || v.fraction !== '00')
      ? '+'
      : '';
  const fraction =
    options.compact && currency === 'TWD' && v.fraction === '00'
      ? ''
      : '.' + v.fraction;
  return (
    sign +
    (currency === 'TWD' ? 'NT$' : currency) +
    ' ' +
    v.whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
    fraction
  );
}
function decimal(input: string | null | undefined, places: number) {
  const v = rounded(input, places);
  return v ? (v.negative ? '−' : '') + v.whole + '.' + v.fraction : '—';
}
export const formatRate = (input: string | null | undefined) =>
  decimal(input, 4);
export const formatFullRate = (input: string | null | undefined) =>
  decimal(input, 10);
export const formatPercent = (input: string | null | undefined) => {
  const v = decimal(input, 2);
  return v === '—' ? v : v + '%';
};
export function formatBudgetInput(input: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(input)) return input;
  const [whole, fraction = ''] = input.split('.');
  return (
    whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction.padEnd(2, '0')
  );
}
export function formatDate(
  input: string | null | undefined,
  mode: 'full' | 'short' | 'group' = 'full',
) {
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return '—';
  const date = new Date(input + 'T00:00:00Z');
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== input
  )
    return '—';
  if (mode === 'group')
    return (
      input.slice(5).replace('-', '/') +
      '　週' +
      '日一二三四五六'[date.getUTCDay()]
    );
  return mode === 'short' ? input.slice(5) : input;
}
