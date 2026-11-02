// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import { Stack, Text, Title, useMantineColorScheme } from '@mantine/core';
import * as echarts from 'echarts/core';
import { PieChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type {
  CategoryReport,
  IncomeReport,
} from '@finmichi/core/report-schemas';
import { formatMoney, formatPercent } from './design/format';
import { tokens } from './design/tokens';
import { incomeCoordinates } from './design/report-chart-data';
echarts.use([
  PieChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);
export default function ReportCharts({ report }: { report: CategoryReport }) {
  const { colorScheme } = useMantineColorScheme();
  const c = tokens[colorScheme === 'dark' ? 'dark' : 'light'];
  const pie = useRef<HTMLDivElement>(null),
    bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const charts: ReturnType<typeof echarts.init>[] = [];
    // Number conversion is only for SQL-derived dimensionless chart coordinates.
    // All monetary totals, ordering, labels and CSV retain SQL numeric strings.
    if (pie.current && report.pie_available) {
      const chart = echarts.init(pie.current);
      charts.push(chart);
      chart.setOption({
        animation: false,
        color: [c.accent, c.income, c.expense, c.warn, c.transfer],
        textStyle: {
          color: c.fg,
          fontFamily: 'IBM Plex Sans, Noto Sans TC, sans-serif',
        },
        tooltip: {
          renderMode: 'richText',
          trigger: 'item',
          backgroundColor: c.surface,
          borderColor: c['line-strong'],
          textStyle: { color: c.fg },
        },
        legend: {
          type: 'scroll',
          bottom: 0,
          textStyle: { color: c['fg-2'] },
          pageTextStyle: { color: c['fg-2'] },
          pageIconColor: c.accent,
          pageIconInactiveColor: c['fg-3'],
        },
        series: [
          {
            type: 'pie',
            radius: ['20%', '55%'],
            center: ['50%', '40%'],
            label: { show: false },
            data: report.pie.map((row) => ({
              name: row.name,
              value: Number(row.percentage),
              tooltip: {
                formatter: () =>
                  `${row.name}\n${formatMoney(row.rollup_amount, report.base_currency)}\n${row.percentage === null ? '' : formatPercent(row.percentage)}`,
              },
            })),
          },
        ],
      });
    }
    if (bar.current) {
      const chart = echarts.init(bar.current);
      charts.push(chart);
      chart.setOption({
        animation: false,
        color: [c.accent, c.income, c.expense, c.warn, c.transfer],
        textStyle: {
          color: c.fg,
          fontFamily: 'IBM Plex Sans, Noto Sans TC, sans-serif',
        },
        tooltip: {
          renderMode: 'richText',
          trigger: 'item',
          backgroundColor: c.surface,
          borderColor: c['line-strong'],
          textStyle: { color: c.fg },
        },
        grid: { left: 8, right: 75, top: 16, bottom: 16, containLabel: true },
        xAxis: {
          type: 'value',
          min: -100,
          max: 100,
          axisLabel: { show: false },
          splitLine: { show: false },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'category',
          inverse: true,
          data: report.bars.map((r) => r.name),
          axisLabel: { width: 80, overflow: 'truncate', color: c['fg-2'] },
          axisLine: { lineStyle: { color: c['line-strong'] } },
          axisTick: { show: false },
        },
        series: [
          {
            type: 'bar',
            barMaxWidth: 25,
            markLine: {
              symbol: 'none',
              label: { show: false },
              lineStyle: { color: c['fg-3'] },
              data: [{ xAxis: 0 }],
            },
            data: report.bars.map((row) => ({
              name: row.name,
              value: Number(row.chart_weight),
              itemStyle: {
                color: row.rollup_amount.startsWith('-') ? c.expense : c.accent,
              },
              label: {
                show: true,
                position: row.rollup_amount.startsWith('-')
                  ? 'insideLeft'
                  : 'insideRight',
                color: c.fg,
                backgroundColor: c.surface,
                padding: [2, 3],
                formatter: () =>
                  formatMoney(row.rollup_amount, report.base_currency),
              },
              tooltip: {
                formatter: () =>
                  `${row.name}\n${formatMoney(row.rollup_amount, report.base_currency)}`,
              },
            })),
          },
        ],
      });
    }
    const observer = new ResizeObserver(() =>
      charts.forEach((c) => c.resize()),
    );
    if (pie.current) observer.observe(pie.current);
    if (bar.current) observer.observe(bar.current);
    return () => {
      observer.disconnect();
      charts.forEach((c) => c.dispose());
    };
  }, [report, c]);
  return (
    <Stack
      className="panel report-charts"
      style={{ minWidth: 0 }}
      data-chart-theme={colorScheme}
    >
      {report.pie_available && (
        <>
          <Title order={3}>第一層科目圓餅圖</Title>
          <div
            ref={pie}
            role="img"
            aria-label="分類圓餅圖"
            style={{ width: '100%', height: 300, minWidth: 0 }}
          />
        </>
      )}
      <Title order={3}>葉科目前十名長條圖</Title>
      <Text size="sm">
        依金額絕對值排序；以最大絕對值等比縮放，零點置中，標籤為實際金額。
      </Text>
      <div
        ref={bar}
        role="img"
        aria-label="分類前十名長條圖"
        style={{ width: '100%', height: 360, minWidth: 0 }}
      />
    </Stack>
  );
}

export function IncomeChart({ report }: { report: IncomeReport }) {
  const root = useRef<HTMLDivElement>(null);
  const { colorScheme } = useMantineColorScheme();
  const c = tokens[colorScheme === 'dark' ? 'dark' : 'light'];
  useEffect(() => {
    if (!root.current) return;
    const chart = echarts.init(root.current);
    const fields = [
      ['營業收入', 'operating_income', c.income],
      ['業外收入', 'non_operating_income', c.accent],
      ['營業支出', 'operating_expense', c.expense],
      ['業外支出', 'non_operating_expense', c.warn],
    ] as const;
    const coordinates = incomeCoordinates(report.periods);
    chart.setOption({
      animation: false,
      textStyle: { color: c.fg },
      aria: { enabled: true },
      tooltip: {
        trigger: 'item',
        renderMode: 'richText',
        backgroundColor: c.surface,
        borderColor: c['line-strong'],
        textStyle: { color: c.fg },
      },
      legend: {
        type: 'scroll',
        bottom: 0,
        textStyle: { color: c['fg-2'] },
        pageTextStyle: { color: c['fg-2'] },
        pageIconColor: c.accent,
        pageIconInactiveColor: c['fg-3'],
      },
      grid: { top: 16, left: 16, right: 16, bottom: 65, containLabel: true },
      xAxis: {
        type: 'category',
        data: report.periods.map((p) => p.label),
        axisLabel: { color: c['fg-2'], hideOverlap: true },
        axisLine: { lineStyle: { color: c['line-strong'] } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { show: false },
        splitLine: { lineStyle: { color: c.line } },
      },
      series: fields.map(([name, key, color]) => ({
        name,
        type: 'bar',
        itemStyle: { color },
        data: report.periods.map((p, index) => ({
          value: coordinates[index]![key],
          tooltip: {
            formatter: () =>
              p.label +
              '\n' +
              name +
              ' ' +
              formatMoney(p[key], report.base_currency),
          },
        })),
      })),
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(root.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [report, c]);
  return (
    <>
      <div
        ref={root}
        role="img"
        aria-label="收支彙總長條圖"
        data-chart-theme={colorScheme}
        style={{ width: '100%', height: 300, minWidth: 0 }}
      />
      <Text size="sm" c="dimmed">
        長條以共同尺度呈現相對金額；完整精確金額請參考提示與下方明細。
      </Text>
    </>
  );
}
