// SPDX-License-Identifier: AGPL-3.0-only
import type { RecurringInput } from './recurring-schemas.js';
type Schedule = Pick<
  RecurringInput,
  | 'frequency'
  | 'interval'
  | 'day_of_month'
  | 'weekday'
  | 'month'
  | 'day'
  | 'start_on'
>;
const parse = (s: string) => new Date(s + 'T00:00:00Z');
function at(year: number, month: number, day: number): string | null {
  if (year < 1 || year > 9999) return null;
  const d = new Date(0);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCFullYear(year, month, 0);
  const last = d.getUTCDate();
  d.setUTCFullYear(year, month - 1, Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
export function nextOccurrence(
  rule: Schedule,
  previous?: string,
): string | null {
  const d = parse(previous ?? rule.start_on),
    y = d.getUTCFullYear(),
    m = d.getUTCMonth();
  if (rule.frequency === 'weekly') {
    d.setUTCDate(
      d.getUTCDate() +
        (previous
          ? 7 * rule.interval
          : (rule.weekday! - d.getUTCDay() + 7) % 7),
    );
    return d.getUTCFullYear() > 9999 ? null : d.toISOString().slice(0, 10);
  }
  const offset = previous ? rule.interval : 0;
  let candidate =
    rule.frequency === 'monthly'
      ? at(
          y + Math.floor((m + offset) / 12),
          ((m + offset) % 12) + 1,
          rule.day_of_month!,
        )
      : at(y + offset, rule.month!, rule.day!);
  if (!previous && candidate && candidate < rule.start_on)
    candidate =
      rule.frequency === 'monthly'
        ? at(
            y + Math.floor((m + rule.interval) / 12),
            ((m + rule.interval) % 12) + 1,
            rule.day_of_month!,
          )
        : at(y + rule.interval, rule.month!, rule.day!);
  return candidate;
}
export function frequencyPreview(
  rule: Schedule & { end_on?: string | null },
  next = nextOccurrence(rule),
) {
  const text =
    rule.frequency === 'monthly'
      ? `每 ${rule.interval} 個月的 ${rule.day_of_month} 日，月底不足取最後一天`
      : rule.frequency === 'weekly'
        ? `每 ${rule.interval} 週的星期${'日一二三四五六'[rule.weekday!]}`
        : `每 ${rule.interval} 年的 ${rule.month} 月 ${rule.day} 日，日期不足取該月最後一天`;
  if (rule.end_on && next && next > rule.end_on) next = null;
  return text + '；下次 ' + (next ?? '無後續日期');
}
