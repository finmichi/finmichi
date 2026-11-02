// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import { useMantineColorScheme } from '@mantine/core';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ProjectReportRow } from '@finmichi/core/report-schemas';
import { tokens } from './design/tokens';
import { units } from './design/display-math';
import { formatMoney } from './design/format';
import { projectReportText as t } from './project-report-messages';
echarts.use([
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);
export default function ProjectCharts({
  row,
  currency,
  trend = false,
}: {
  row: ProjectReportRow;
  currency: string;
  trend?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    { colorScheme } = useMantineColorScheme();
  useEffect(() => {
    if (!ref.current) return;
    const c = tokens[colorScheme === 'dark' ? 'dark' : 'light'];
    const roots = row.items.filter(
      (i) => i.kind === 'expense' && i.parent_id === null,
    );
    const series = trend
      ? [
          {
            name: t.income,
            values: row.months.map((m) => m.income),
            color: c.income,
          },
          {
            name: t.expense,
            values: row.months.map((m) => m.expense),
            color: c.expense,
          },
        ]
      : [
          {
            name: t.expense,
            values: roots.map((i) => i.rollup_amount),
            color: c.accent,
          },
        ];
    const max = series
      .flatMap((s) => s.values)
      .reduce((m, v) => {
        const x = units(v);
        return (x < 0n ? -x : x) > m ? (x < 0n ? -x : x) : m;
      }, 0n);
    const chart = echarts.init(ref.current);
    chart.setOption({
      animation: false,
      textStyle: { color: c.fg },
      legend: { textStyle: { color: c['fg-2'] } },
      tooltip: {
        renderMode: 'richText',
        backgroundColor: c.surface,
        borderColor: c['line-strong'],
        textStyle: { color: c.fg },
      },
      grid: { left: 12, right: 12, top: 35, bottom: 45, containLabel: true },
      xAxis: {
        type: 'category',
        data: trend ? row.months.map((m) => m.month) : roots.map((i) => i.name),
        axisLabel: { color: c['fg-2'], width: 70, overflow: 'truncate' },
      },
      yAxis: {
        type: 'value',
        axisLabel: { show: false },
        splitLine: { lineStyle: { color: c.line } },
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'bar',
        itemStyle: { color: s.color },
        data: s.values.map((v) => ({
          value: max === 0n ? 0 : Number((units(v) * 1000000n) / max) / 10000,
          tooltip: {
            formatter: () => `${s.name}\n${formatMoney(v, currency)}`,
          },
        })),
      })),
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [row, currency, trend, colorScheme]);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={trend ? t.trend : t.composition}
      data-chart-theme={colorScheme}
      style={{ width: '100%', height: 280, minWidth: 0 }}
    />
  );
}
