// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { tokens } from './tokens';
import { createLedgerTheme } from './theme';
const pairs = [
  ['fg', 'bg'],
  ['on-nav-accent', 'nav-accent'],
  ['nav-accent', 'nav'],
  ['nav-accent', 'nav-active'],
  ['fg', 'surface'],
  ['fg', 'surface-2'],
  ['fg-2', 'bg'],
  ['fg-2', 'surface-2'],
  ['fg-3', 'bg'],
  ['fg-3', 'surface'],
  ['fg-3', 'surface-2'],
  ['accent', 'surface'],
  ['accent', 'surface-2'],
  ['accent', 'accent-soft'],
  ['income', 'surface'],
  ['income', 'surface-2'],
  ['income', 'income-soft'],
  ['expense', 'surface'],
  ['expense', 'surface-2'],
  ['expense', 'expense-soft'],
  ['transfer', 'surface'],
  ['transfer', 'surface-2'],
  ['transfer', 'transfer-soft'],
  ['warn', 'surface'],
  ['warn', 'warn-soft'],
  ['nav-fg', 'nav'],
  ['nav-dim', 'nav'],
  ['nav-fg', 'nav-active'],
  ['on-accent', 'accent'],
  ['nav-fg', 'nav-2'],
  ['fg-2', 'surface'],
  ['accent', 'bg'],
  ['on-accent', 'expense'],
  ['on-accent', 'income'],
  ['on-accent', 'warn'],
  ['on-accent', 'transfer'],
] as const;
function luminance(hex: string) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722;
}
for (const mode of ['light', 'dark'] as const)
  it(
    mode +
      ' official rev.1.1 contrast matrix meets AA; theme uses same palette',
    () => {
      const theme = createLedgerTheme(mode);
      expect(theme.colors!.brand![6]).toBe(tokens[mode].accent);
      const colors = theme.other!.tokens as (typeof tokens)[typeof mode];
      for (const [a, b] of pairs) {
        const l = luminance(colors[a]),
          r = luminance(colors[b]);
        expect(
          (Math.max(l, r) + 0.05) / (Math.min(l, r) + 0.05),
          a + '/' + b,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

for (const mode of ['light', 'dark'] as const)
  it(
    mode + ' fine-pointer scrollbar thumb/track meets non-text contrast',
    () => {
      const thumb = luminance(tokens[mode]['fg-3']);
      const track = luminance(tokens[mode]['surface-2']);
      expect(
        (Math.max(thumb, track) + 0.05) / (Math.min(thumb, track) + 0.05),
      ).toBeGreaterThanOrEqual(3);
    },
  );
