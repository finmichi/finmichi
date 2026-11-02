// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import { useMantineColorScheme } from '@mantine/core';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { NetWorthFlowReport } from '@finmichi/core/report-schemas';
import { tokens } from './design/tokens';
import { units } from './design/display-math';
import { formatMoney } from './design/format';
echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);
export default function FlowChart({ report }: { report: NetWorthFlowReport }) {
  const ref = useRef<HTMLDivElement>(null),
    { colorScheme } = useMantineColorScheme();
  useEffect(() => {
    if (!ref.current) return;
    const c = tokens[colorScheme === 'dark' ? 'dark' : 'light'],
      chart = echarts.init(ref.current),
      keys = ['closing', 'income', 'expense'] as const;
    let max = 0n;
    for (const p of report.periods)
      for (const k of keys) {
        const n = units(p[k]),
          abs = n < 0n ? -n : n;
        if (abs > max) max = abs;
      }
    chart.setOption({
      animation: false,
      textStyle: {
        color: c.fg,
        fontFamily: 'IBM Plex Sans, Noto Sans TC, sans-serif',
      },
      color: [c.accent, c.income, c.expense],
      legend: { textStyle: { color: c.fg } },
      grid: { left: 12, right: 12, top: 40, bottom: 40, containLabel: true },
      tooltip: {
        trigger: 'axis',
        renderMode: 'richText',
        backgroundColor: c.surface,
        borderColor: c['line-strong'],
        textStyle: { color: c.fg },
        formatter: (params: unknown) => {
          const first = Array.isArray(params) ? params[0] : params;
          const index =
            first && typeof first === 'object' && 'dataIndex' in first
              ? Number(first.dataIndex)
              : 0;
          const p = report.periods[index];
          return p
            ? `${p.label}\n期末 ${formatMoney(p.closing, report.base_currency)}\n收入 ${formatMoney(p.income, report.base_currency)}\n支出 ${formatMoney(p.expense, report.base_currency)}`
            : '';
        },
      },
      xAxis: {
        type: 'category',
        data: report.periods.map((p) => p.label),
        axisLabel: { color: c['fg-2'] },
      },
      yAxis: {
        type: 'value',
        axisLabel: { show: false },
        splitLine: { lineStyle: { color: c.line } },
      },
      series: keys.map((k, index) => ({
        name: ['期末淨值', '收入', '支出'][index],
        type: index === 0 ? 'line' : 'bar',
        data: report.periods.map((p) =>
          max === 0n ? 0 : Number((units(p[k]) * 1000000n) / max) / 10000,
        ),
      })),
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [report, colorScheme]);
  return (
    <section className="panel report-section">
      <h3>期末淨值與收支</h3>
      <div
        ref={ref}
        data-chart-theme={colorScheme === 'dark' ? 'dark' : 'light'}
        role="img"
        aria-label="期末淨值折線與收支長條圖；精確金額請參考明細"
        style={{ height: 300, width: '100%' }}
      />
    </section>
  );
}
