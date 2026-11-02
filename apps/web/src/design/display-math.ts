// SPDX-License-Identifier: AGPL-3.0-only
// Presentation arithmetic only. Values stay decimal strings/BigInt, including aggregates.
export function units(value: string, scale = 6): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(value))
    throw new Error('Invalid decimal display value');
  const negative = value.startsWith('-');
  const [a, b = ''] = (negative ? value.slice(1) : value).split('.');
  return (
    (negative ? -1n : 1n) *
    (BigInt(a!) * 10n ** BigInt(scale) +
      BigInt(b.padEnd(scale, '0').slice(0, scale)))
  );
}
export function decimal(value: bigint, scale = 6): string {
  const n = value < 0n ? -value : value,
    factor = 10n ** BigInt(scale);
  return `${value < 0n ? '-' : ''}${n / factor}.${String(n % factor).padStart(scale, '0')}`;
}
export const add = (values: string[]) =>
  decimal(values.reduce((s, v) => s + units(v), 0n));
export const negate = (value: string) => decimal(-units(value));
export function percent(value: string, total: string): string | null {
  const a = units(value),
    b = units(total);
  if (b === 0n) return null;
  const negative = a < 0n !== b < 0n,
    n = (a < 0n ? -a : a) * 100n * 10n ** 10n,
    d = b < 0n ? -b : b;
  const rounded = n / d + ((n % d) * 2n >= d ? 1n : 0n);
  return decimal(negative ? -rounded : rounded, 10);
}
export function todayTaipei(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function monthStart(date: string, offset = 0) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 10);
}
