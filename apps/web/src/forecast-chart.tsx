// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import { useMantineColorScheme, Text } from '@mantine/core';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { CashForecastReport } from '@finmichi/core/cash-forecast-schemas';
import { tokens } from './design/tokens';
import { units } from './design/display-math';
import { formatMoney } from './design/format';
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);
export default function ForecastChart({
  report: r,
}: {
  report: CashForecastReport;
}) {
  const ref = useRef<HTMLDivElement>(null),
    { colorScheme } = useMantineColorScheme();
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current),
      c = tokens[colorScheme === 'dark' ? 'dark' : 'light'];
    const series = [
      { id: 'total', name: '合計', values: r.days.map((d) => d.total) },
      ...r.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        values: r.days.map(
          (d) => d.balances.find((b) => b.account_id === a.id)!.balance,
        ),
      })),
    ];
    let max = 0n;
    for (const s of series)
      for (const v of s.values) {
        const n = units(v),
          a = n < 0n ? -n : n;
        if (a > max) max = a;
      }
    chart.setOption({
      animation: false,
      textStyle: { color: c.fg },
      color: [c.accent, c.income, c.expense, c.warn, c.transfer],
      legend: {
        type: 'scroll',
        textStyle: { color: c.fg },
        pageTextStyle: { color: c.fg },
        pageIconColor: c.accent,
      },
      grid: { left: 12, right: 12, top: 50, bottom: 40, containLabel: true },
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
          return r.days[index]
            ? r.days[index]!.date +
                '\n' +
                series
                  .map(
                    (s) =>
                      s.name +
                      ' ' +
                      formatMoney(s.values[index], r.base_currency),
                  )
                  .join('\n')
            : '';
        },
      },
      xAxis: {
        type: 'category',
        data: r.days.map((d) => d.date),
        axisLabel: { color: c['fg-2'], hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        axisLabel: { show: false },
        splitLine: { lineStyle: { color: c.line } },
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'line',
        showSymbol: false,
        data: s.values.map((v) =>
          max === 0n ? 0 : Number((units(v) * 1000000n) / max) / 10000,
        ),
      })),
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [r, colorScheme]);
  return (
    <section className="panel report-section">
      <h4>每日預估餘額</h4>
      <div
        ref={ref}
        role="img"
        aria-label="每日合計與各帳戶預估餘額折線圖"
        data-chart-theme={colorScheme === 'dark' ? 'dark' : 'light'}
        style={{ height: 300, width: '100%', minWidth: 0 }}
      />
      <Text size="sm">曲線依共同尺度呈現；滑過日期可查看精確日終餘額。</Text>
    </section>
  );
}
