import { useMemo } from 'react';
import { useTheme } from '../theme.js';
import { humanize } from '../hooks.js';

// Recharts draws plain SVG, so it needs real colour values. Resolve them from the CSS tokens
// (and re-resolve when the theme flips) so charts always match the rest of the UI.
export function useChartTheme() {
  const { resolved } = useTheme();
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const rgb = (name) => `rgb(${cs.getPropertyValue(`--${name}`).trim().split(/\s+/).join(',')})`;
    return {
      grid: rgb('line'), axis: rgb('muted'), cursor: rgb('sunken'),
      series: Array.from({ length: 8 }, (_, i) => cs.getPropertyValue(`--chart-${i + 1}`).trim()),
      success: rgb('success-dot'), danger: rgb('danger-dot'), info: rgb('info-dot'),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);
}

export const xAxisProps = (t) => ({ tick: { fill: t.axis, fontSize: 12 }, tickLine: false, axisLine: { stroke: t.grid }, tickMargin: 8 });
export const yAxisProps = (t) => ({ tick: { fill: t.axis, fontSize: 12 }, tickLine: false, axisLine: false, width: 44 });
export const gridProps = (t) => ({ stroke: t.grid, strokeDasharray: '3 4', vertical: false });
export const legendProps = (t) => ({
  iconType: 'circle', iconSize: 8, wrapperStyle: { fontSize: 12, paddingTop: 8 },
  formatter: (v) => <span style={{ color: t.axis }}>{humanize(v)}</span>,
});

export function ChartTooltip({ active, payload, label, unit = '', format }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-[8rem] rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      <p className="mb-1.5 font-medium text-ink">{label}</p>
      <ul className="space-y-1">
        {payload.filter((p) => p.value !== null && p.value !== undefined).map((p) => (
          <li key={p.dataKey} className="flex items-center gap-2 text-muted">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color || p.fill || p.stroke }} />
            <span>{p.name ? humanize(p.name) : humanize(p.dataKey)}</span>
            <span className="ml-auto pl-4 font-medium tabular-nums text-ink">{format ? format(p.value) : p.value}{unit}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
