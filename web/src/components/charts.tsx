/** Recharts wrappers: theme-aware, responsive, and consistent across the app. */

import { useMemo } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useI18n } from '../lib/i18n';
import { money, num, PLATFORM_COLORS, shortDate } from '../lib/format';

/** Reads live token values so charts follow the theme and any brand override. */
function useChartTheme() {
  return useMemo(() => {
    if (typeof window === 'undefined') {
      return { grid: '#242b39', axis: '#949eaf', brand: '#818cf8', accent: '#2dd4bf', surface: '#11141d', line: '#252b39' };
    }
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => {
      const raw = styles.getPropertyValue(name).trim();
      return raw ? `rgb(${raw})` : fallback;
    };
    return {
      grid: token('--c-line', '#242b39'),
      axis: token('--c-muted', '#949eaf'),
      brand: token('--c-brand', '#818cf8'),
      accent: token('--c-accent', '#2dd4bf'),
      surface: token('--c-surface', '#11141d'),
      line: token('--c-line', '#252b39'),
    };
  }, []);
}

interface TooltipEntry {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string;
}

function ChartTooltip({
  active, payload, label, formatter,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  formatter?: (value: number, key: string) => string;
}) {
  const { lang } = useI18n();
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-xl border border-line bg-surface/95 px-3 py-2 shadow-lift backdrop-blur">
      {label ? <p className="mb-1.5 text-[12px] font-medium text-muted">{label}</p> : null}
      <div className="space-y-1">
        {payload.map((entry) => (
          <div key={entry.dataKey ?? entry.name} className="flex items-center gap-2 text-[13px]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color }} />
            <span className="text-muted">{entry.name}</span>
            <span className="ms-auto tabular font-medium text-fg">
              {formatter && entry.value !== undefined
                ? formatter(entry.value, String(entry.dataKey))
                : num(entry.value ?? 0, lang)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Any row keyed by an ISO date; the measures on it vary by chart. */
export interface SeriesPoint {
  date: string;
}

export function TrendChart<T extends SeriesPoint>({
  data, keys, height = 260, stacked = false, currency = false,
}: {
  data: T[];
  keys: Array<{ key: string; label: string; color?: string }>;
  height?: number;
  stacked?: boolean;
  currency?: boolean;
}) {
  const theme = useChartTheme();
  const { lang } = useI18n();
  const palette = [theme.brand, theme.accent, '#a78bfa', '#fbbf24'];

  return (
    <div className="w-full min-w-0 overflow-hidden">
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <defs>
          {keys.map((entry, index) => (
            <linearGradient key={entry.key} id={`grad-${entry.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={entry.color ?? palette[index % palette.length]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={entry.color ?? palette[index % palette.length]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fill: theme.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          minTickGap={28}
          tickFormatter={(value: string) => shortDate(value, lang)}
        />
        <YAxis
          tick={{ fill: theme.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={58}
          tickFormatter={(value: number) => (currency ? money(value, lang, true) : num(value, lang, true))}
        />
        <Tooltip
          content={
            <ChartTooltip formatter={(value) => (currency ? money(value, lang) : num(value, lang))} />
          }
          cursor={{ stroke: theme.grid }}
        />
        {keys.length > 1 ? (
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 12, color: theme.axis, paddingTop: 8 }}
          />
        ) : null}
        {keys.map((entry, index) => (
          <Area
            key={entry.key}
            type="monotone"
            dataKey={entry.key}
            name={entry.label}
            stackId={stacked ? 'a' : undefined}
            stroke={entry.color ?? palette[index % palette.length]}
            strokeWidth={2}
            fill={`url(#grad-${entry.key})`}
            animationDuration={700}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
    </div>
  );
}

export function ComparisonBars({
  data, dataKey, labelKey = 'label', height = 260, currency = false,
}: {
  data: Array<Record<string, string | number>>;
  dataKey: string;
  labelKey?: string;
  height?: number;
  currency?: boolean;
}) {
  const theme = useChartTheme();
  const { lang } = useI18n();

  return (
    <div className="w-full min-w-0 overflow-hidden">
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
        <XAxis dataKey={labelKey} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis
          tick={{ fill: theme.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={58}
          tickFormatter={(value: number) => (currency ? money(value, lang, true) : num(value, lang, true))}
        />
        <Tooltip
          content={<ChartTooltip formatter={(value) => (currency ? money(value, lang) : num(value, lang))} />}
          cursor={{ fill: `${theme.grid}55` }}
        />
        <Bar dataKey={dataKey} radius={[6, 6, 0, 0]} animationDuration={650}>
          {data.map((entry, index) => (
            <Cell
              key={index}
              fill={PLATFORM_COLORS[String(entry.platform ?? '')] ?? theme.brand}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    </div>
  );
}

export function DonutChart({
  data, height = 240, currency = true,
}: {
  data: Array<{ label: string; value: number; platform?: string }>;
  height?: number;
  currency?: boolean;
}) {
  const theme = useChartTheme();
  const { lang } = useI18n();
  const palette = [theme.brand, theme.accent, '#a78bfa', '#fbbf24', '#f472b6', '#34d399'];
  const total = data.reduce((sum, entry) => sum + entry.value, 0);

  if (total === 0) {
    return <div className="grid place-items-center text-sm text-muted" style={{ height }}>No data</div>;
  }

  return (
    <div className="w-full min-w-0 overflow-hidden">
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="label"
          innerRadius="58%"
          outerRadius="86%"
          paddingAngle={2}
          stroke="none"
          animationDuration={650}
        >
          {data.map((entry, index) => (
            <Cell key={entry.label} fill={PLATFORM_COLORS[entry.platform ?? ''] ?? palette[index % palette.length]} />
          ))}
        </Pie>
        <Tooltip content={<ChartTooltip formatter={(value) => (currency ? money(value, lang) : num(value, lang))} />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: theme.axis }} />
      </PieChart>
    </ResponsiveContainer>
    </div>
  );
}

/** Compact inline trend for KPI tiles. */
export function Sparkline<T extends SeriesPoint>({ data, dataKey, color }: { data: T[]; dataKey: string; color?: string }) {
  const theme = useChartTheme();
  return (
    <div className="w-full min-w-0 overflow-hidden">
    <ResponsiveContainer width="100%" height={38}>
      <LineChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color ?? theme.brand}
          strokeWidth={1.75}
          dot={false}
          animationDuration={600}
        />
      </LineChart>
    </ResponsiveContainer>
    </div>
  );
}
