// SPDX-License-Identifier: AGPL-3.0-only
import {
  Badge,
  Button,
  createTheme,
  type CSSVariablesResolver,
} from '@mantine/core';
import { tokens } from './tokens';
const palette = (
  soft: string,
  ink: string,
): [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
] => [soft, soft, soft, ink, ink, ink, ink, ink, ink, ink];
export function createLedgerTheme(mode: 'light' | 'dark') {
  const c = tokens[mode];
  return createTheme({
    black: tokens.dark['on-accent'],
    white: tokens.light['on-accent'],
    fontFamily: '"IBM Plex Sans", "Noto Sans TC", system-ui, sans-serif',
    fontFamilyMonospace: '"IBM Plex Mono", monospace',
    fontSizes: {
      xs: '0.75rem',
      sm: '0.8125rem',
      md: '0.875rem',
      lg: '0.9375rem',
      xl: '1.125rem',
    },
    headings: {
      fontFamily: '"IBM Plex Sans", "Noto Sans TC", system-ui, sans-serif',
      fontWeight: '600',
      sizes: {
        h1: { fontSize: '18px', lineHeight: '1.5' },
        h2: { fontSize: '18px', lineHeight: '1.5' },
        h3: { fontSize: '13.5px', lineHeight: '1.5' },
      },
    },
    spacing: { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '24px' },
    other: { tokens: c },
    defaultRadius: 6,
    primaryColor: 'brand',
    primaryShade: 6,
    autoContrast: true,
    breakpoints: {
      xs: '30em',
      sm: '40em',
      md: '56.25em',
      lg: '75em',
      xl: '90em',
    },
    colors: {
      dark: [
        c.fg,
        c['fg-2'],
        c['fg-3'],
        c['line-strong'],
        c.line,
        c['surface-2'],
        c['surface-2'],
        c.surface,
        c.bg,
        c.nav,
      ],
      brand: palette(c['accent-soft'], c.accent),
      red: palette(c['expense-soft'], c.expense),
      green: palette(c['income-soft'], c.income),
      yellow: palette(c['warn-soft'], c.warn),
      blue: palette(c['accent-soft'], c.accent),
      orange: palette(c['warn-soft'], c.warn),
      gray: [
        c['surface-2'],
        c['surface-2'],
        c.line,
        c['line-strong'],
        c['line-strong'],
        c['fg-3'],
        c['fg-3'],
        c['fg-2'],
        c.fg,
        c.fg,
      ],
    },
    components: {
      NumberInput: { defaultProps: { hideControls: true } },
      Badge: Badge.extend({
        vars: (_theme, props) => {
          const ink =
            props.color === 'red'
              ? c.expense
              : props.color === 'green'
                ? c.income
                : props.color === 'gray'
                  ? c.transfer
                  : props.color === 'yellow' || props.color === 'orange'
                    ? c.warn
                    : c.accent;
          const soft =
            props.color === 'red'
              ? c['expense-soft']
              : props.color === 'green'
                ? c['income-soft']
                : props.color === 'gray'
                  ? c['transfer-soft']
                  : props.color === 'yellow' || props.color === 'orange'
                    ? c['warn-soft']
                    : c['accent-soft'];
          const filled = !props.variant || props.variant === 'filled';
          return {
            root: {
              '--badge-bg': filled
                ? ink
                : props.variant === 'light'
                  ? soft
                  : c.surface,
              '--badge-color': filled ? c['on-accent'] : ink,
              '--badge-bd':
                props.variant === 'outline'
                  ? '1px solid ' + ink
                  : '1px solid transparent',
            },
          };
        },
      }),
      Button: Button.extend({
        styles: { root: { fontWeight: 500 } },
        vars: (_theme, props) => {
          const ink =
            props.color === 'red'
              ? c.expense
              : props.color === 'green'
                ? c.income
                : props.color === 'yellow'
                  ? c.warn
                  : c.accent;
          const soft =
            props.color === 'red'
              ? c['expense-soft']
              : props.color === 'green'
                ? c['income-soft']
                : props.color === 'yellow'
                  ? c['warn-soft']
                  : c['accent-soft'];
          const filled = !props.variant || props.variant === 'filled';
          const bg = filled
            ? ink
            : props.variant === 'light'
              ? soft
              : c.surface;
          return {
            root: {
              '--button-bg': bg,
              '--button-hover': bg,
              '--button-color': filled ? c['on-accent'] : ink,
              '--button-hover-color': filled ? c['on-accent'] : ink,
              '--button-bd':
                props.variant === 'outline'
                  ? '1px solid ' + ink
                  : '1px solid transparent',
            },
          };
        },
      }),
      Paper: {
        styles: {
          root: { background: 'var(--surface)', borderColor: 'var(--line)' },
        },
      },
      Card: {
        styles: {
          root: { background: 'var(--surface)', borderColor: 'var(--line)' },
        },
      },
      Title: { styles: { root: { color: 'var(--fg)' } } },
      Input: {
        styles: {
          input: {
            background: 'var(--field-bg, var(--surface))',
            color: 'var(--field-fg, var(--fg))',
            borderColor: 'var(--field-line, var(--line-strong))',
          },
        },
      },
      Tabs: { styles: { tab: { color: 'var(--fg-2)' } } },
    },
  });
}
const variables = (mode: 'light' | 'dark') =>
  Object.fromEntries(
    Object.entries(tokens[mode]).map(([k, v]) => ['--' + k, v]),
  );
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    '--font-num': '"IBM Plex Mono", monospace',
    '--font-sans': '"IBM Plex Sans", "Noto Sans TC", system-ui, sans-serif',
  },
  light: {
    ...variables('light'),
    '--mantine-color-body': tokens.light.bg,
    '--mantine-color-text': tokens.light.fg,
    '--mantine-color-dimmed': tokens.light['fg-3'],
  },
  dark: {
    ...variables('dark'),
    '--mantine-color-body': tokens.dark.bg,
    '--mantine-color-text': tokens.dark.fg,
    '--mantine-color-dimmed': tokens.dark['fg-3'],
  },
});
