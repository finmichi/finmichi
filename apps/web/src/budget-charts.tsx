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
import type { BudgetReport } from '@finmichi/core/report-schemas';
import { tokens } from './design/tokens';
import { formatMoney } from './design/format';
import { units } from './design/display-math';
echarts.use([
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);
export default function BudgetCharts({ report }: { report: BudgetReport }) {
  const ref = useRef<HTMLDivElement>(null),
    { colorScheme } = useMantineColorScheme();
  useEffect(() => {
    if (!ref.current) return;
    const c = tokens[colorScheme === 'dark' ? 'dark' : 'light'],
      chart = echarts.init(ref.current),
      keys = ['budget_total', 'actual_total'] as const;
    let max = 0n;
    for (const p of report.periods)
      for (const k of keys) {
        const n = units(p[k]),
          v = n < 0n ? -n : n;
        if (v > max) max = v;
      }
    chart.setOption({
      animation: false,
      textStyle: {
        color: c.fg,
        fontFamily: 'IBM Plex Sans, Noto Sans TC, sans-serif',
      },
      color: [c.accent, report.kind === 'expense' ? c.expense : c.income],
      grid: { left: 12, right: 12, top: 48, bottom: 40, containLabel: true },
      legend: { top: 8, textStyle: { color: c.fg } },
      tooltip: {
        renderMode: 'richText',
        trigger: 'axis',
        formatter: (params: unknown) => {
          const first = Array.isArray(params) ? params[0] : params;
          const i =
            first && typeof first === 'object' && 'dataIndex' in first
              ? Number(first.dataIndex)
              : 0;
          const p = report.periods[i];
          return p
            ? `${p.label}\n預算 ${formatMoney(p.budget_total, report.base_currency)}\n實際 ${formatMoney(p.actual_total, report.base_currency)}`
            : '';
        },
        backgroundColor: c.surface,
        borderColor: c['line-strong'],
        textStyle: { color: c.fg },
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
      series: keys.map((key, n) => ({
        name: n === 0 ? '預算' : '實際',
        type: 'bar',
        data: report.periods.map((p) => ({
          value:
            max === 0n ? 0 : Number((units(p[key]) * 1000000n) / max) / 10000,
          tooltip: {
            formatter: () =>
              `${p.label} ${n === 0 ? '預算' : '實際'}\n${formatMoney(p[key], report.base_currency)}`,
          },
        })),
      })),
    });
    const resize = () => chart.resize();
    const observer = new ResizeObserver(resize);
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [report, colorScheme]);
  return (
    <section className="panel report-section">
      <div className="panel-heading">
        <h3>各時段預算與實際</h3>
      </div>
      <div
        ref={ref}
        data-chart-theme={colorScheme === 'dark' ? 'dark' : 'light'}
        role="img"
        aria-label="各時段預算與實際長條圖；精確數字請參考明細"
        style={{ height: 300, width: '100%' }}
      />
    </section>
  );
}
