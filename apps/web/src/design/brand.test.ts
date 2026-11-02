// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brand, tokens } from './tokens';
const publicRoot = resolve(import.meta.dirname, '../../public');
const root = resolve(publicRoot, 'brand');
const text = (name: string) => readFileSync(resolve(root, name), 'utf8');

describe('FinMichi brand delivery', () => {
  it('ships real vector paths and no embedded bitmap, runtime font, script or external reference', () => {
    for (const file of readdirSync(root).filter((f) => f.endsWith('.svg'))) {
      const svg = text(file);
      expect(svg).toContain('<path');
      expect(svg).not.toMatch(
        /<(?:image|text|script|foreignObject)\b|data:|@font-face|href=|url\(/i,
      );
    }
    for (const file of [
      'finmichi-wordmark.svg',
      'finmichi-wordmark-reversed.svg',
    ]) {
      const svg = text(file);
      expect(svg.match(/data-letter=/g)).toHaveLength(8);
      expect(svg.match(/<circle/g)).toHaveLength(1);
      expect(svg).toContain('id="michi-first-i-dot"');
      // Original i dots are rectangles; only character 4 loses its upper contour.
      for (const index of [1, 7]) {
        expect(
          svg.match(new RegExp(`data-letter="${index}"[^>]+`))?.[0],
        ).toContain('1470');
      }
      expect(svg.match(/data-letter="4"[^>]+/)?.[0]).not.toContain('1470');
    }
  });
  it('retains at least three viewBox units of sun/path separation at every icon scale', () => {
    const points = [
      [8, 52],
      [20, 22],
      [32, 40],
      [44, 14],
      [56, 52],
    ] as const;
    for (const file of [
      'finmichi-mark.svg',
      'app-icon.svg',
      'favicon.svg',
      'maskable-icon.svg',
    ]) {
      const svg = text(file);
      expect(svg).toContain('M8 52 L20 22 L32 40 L44 14 L56 52');
      const circle = svg.match(
        /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/,
      )!;
      const [cx, cy, radius] = circle.slice(1).map(Number) as [
        number,
        number,
        number,
      ];
      const stroke = Number(svg.match(/stroke-width="([\d.]+)"/)![1]);
      const scale = Number(svg.match(/scale\(([\d.]+)\)/)?.[1] ?? '1');
      const distances = points.slice(1).map(([bx, by], index) => {
        const [ax, ay] = points[index]!;
        const dx = bx - ax,
          dy = by - ay;
        const t = Math.max(
          0,
          Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / (dx * dx + dy * dy)),
        );
        return Math.hypot(cx - ax - t * dx, cy - ay - t * dy);
      });
      expect(
        (Math.min(...distances) - stroke / 2 - radius) * scale,
        file,
      ).toBeGreaterThanOrEqual(3);
    }
  });
  it('delivers all PNG dimensions and keeps installed PWA identity unchanged', () => {
    for (const [file, width, height] of [
      ['icon-16.png', 16, 16],
      ['icon-32.png', 32, 32],
      ['apple-touch-icon.png', 180, 180],
      ['icon-192.png', 192, 192],
      ['icon-512.png', 512, 512],
      ['maskable-512.png', 512, 512],
      ['og-image.png', 1200, 630],
    ] as const) {
      const png = readFileSync(resolve(root, file));
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        width,
        height,
      ]);
    }
    const manifest = JSON.parse(
      readFileSync(resolve(publicRoot, 'manifest.webmanifest'), 'utf8'),
    );
    expect([manifest.id, manifest.start_url, manifest.scope]).toEqual([
      '/',
      '/',
      '/',
    ]);
    expect(manifest.theme_color).toBe(brand.navy);
    expect(manifest.background_color).toBe(brand.stone);
    expect(manifest.icons).toContainEqual({
      src: '/brand/maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    });
  });
  it('keeps income and expense semantics while dark primary is blue rather than income green', () => {
    expect([tokens.light.income, tokens.dark.income]).toEqual([
      '#137a52',
      '#3fbf88',
    ]);
    expect([tokens.light.expense, tokens.dark.expense]).toEqual([
      '#b53f35',
      '#ef7a6e',
    ]);
    expect(tokens.light.accent).toBe(brand.navy);
    const rgb = [1, 3, 5].map((i) =>
      parseInt(tokens.dark.accent.slice(i, i + 2), 16),
    );
    expect(rgb[2]! - rgb[1]!).toBeGreaterThan(20);
    expect(rgb[1]! - rgb[0]!).toBeGreaterThan(20);
  });
});
