"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { fmt, niceTicks } from "@/lib/format";

export type LineSeries = { id: string; label: string; shortLabel?: string; slot: string; values: number[] };

type Props = {
  x: string[]; // ISO dates, one per point
  series: LineSeries[];
  height?: number;
  valueLabel?: string;
};

const PAD = { top: 12, right: 16, bottom: 28, left: 52 };
const LABEL_GUTTER = 100; // room for direct labels at the line ends
const MIN_LABEL_GAP = 15;

/** Multi-series line chart with a crosshair tooltip, direct end labels and a table view. */
export function LineChart({ x, series, height = 300, valueLabel = "Visitors" }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const directLabels = width >= 560 && series.length <= 4;
  const right = PAD.right + (directLabels ? LABEL_GUTTER : 0);
  const plotW = width - PAD.left - right;
  const plotH = height - PAD.top - PAD.bottom;

  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1];
  const xAt = (i: number) => PAD.left + (x.length <= 1 ? plotW / 2 : (i / (x.length - 1)) * plotW);
  const yAt = (v: number) => PAD.top + plotH - (v / yMax) * plotH;

  // First point of each month becomes an x tick; thin them out on narrow screens.
  const monthTicks = useMemo(() => {
    const idx = x.map((d, i) => [d, i] as const).filter(([d], i) => i === 0 || d.slice(0, 7) !== x[i - 1].slice(0, 7));
    const every = width < 520 ? 3 : width < 760 ? 2 : 1;
    return idx.filter((_, k) => k % every === 0).map(([, i]) => i);
  }, [x, width]);

  // Direct labels at the last point, nudged apart so they never overlap.
  const endLabels = useMemo(() => {
    const items = series
      .map((s) => ({ s, y: yAt(s.values[s.values.length - 1] ?? 0) }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) {
      if (items[i].y - items[i - 1].y < MIN_LABEL_GAP) items[i].y = items[i - 1].y + MIN_LABEL_GAP;
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, yMax, plotH]);

  function onMove(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(x.length - 1, Math.round(rel * (x.length - 1)))));
  }

  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join("");
  const tooltipLeft = hover === null ? 0 : xAt(hover);
  const flip = tooltipLeft > width * 0.6;

  return (
    <div>
      {series.length > 1 && (
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Legend">
          {series.map((s) => (
            <li key={s.id} className={`${s.slot} flex items-center gap-1.5`}>
              <span className="swatch inline-block h-0.5 w-4 rounded-full" aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={wrap} className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${valueLabel} per week by venue`}
          className="block h-auto w-full"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? "chart-axis" : "chart-grid"} x1={PAD.left} x2={PAD.left + plotW} y1={yAt(t)} y2={yAt(t)} />
              <text className="chart-tick tabular" x={PAD.left - 8} y={yAt(t)} dy="0.32em" textAnchor="end">
                {fmt.compact(t)}
              </text>
            </g>
          ))}
          {monthTicks.map((i) => (
            <text key={i} className="chart-tick" x={xAt(i)} y={height - 8} textAnchor="middle">
              {new Date(`${x[i]}T00:00:00`).toLocaleDateString("en-NZ", { month: "short" })}
            </text>
          ))}

          {series.map((s) => (
            <path key={s.id} className={`${s.slot} chart-line`} d={path(s.values)} />
          ))}

          {directLabels &&
            endLabels.map(({ s, y }) => (
              <text key={s.id} className="chart-label" x={PAD.left + plotW + 8} y={y} dy="0.32em">
                {s.shortLabel ?? s.label}
              </text>
            ))}

          {hover !== null && (
            <g aria-hidden>
              <line className="chart-crosshair" x1={xAt(hover)} x2={xAt(hover)} y1={PAD.top} y2={PAD.top + plotH} />
              {series.map((s) => (
                <circle key={s.id} className={`${s.slot} chart-dot`} cx={xAt(hover)} cy={yAt(s.values[hover] ?? 0)} r={4.5} />
              ))}
            </g>
          )}

          <rect
            x={PAD.left}
            y={PAD.top}
            width={Math.max(0, plotW)}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>

        {hover !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md"
            style={flip ? { right: width - tooltipLeft + 12 } : { left: tooltipLeft + 12 }}
          >
            <div className="mb-1 font-medium text-ink">Week of {fmt.date(x[hover])}</div>
            {[...series]
              .sort((a, b) => (b.values[hover] ?? 0) - (a.values[hover] ?? 0))
              .map((s) => (
                <div key={s.id} className={`${s.slot} flex items-center justify-between gap-4`}>
                  <span className="flex items-center gap-1.5 text-ink-2">
                    <span className="swatch inline-block size-2 rounded-full" aria-hidden />
                    {s.label}
                  </span>
                  <span className="tabular text-ink">{fmt.int(s.values[hover] ?? 0)}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      <details className="mt-3 text-xs text-ink-2">
        <summary className="cursor-pointer select-none">View as table</summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-md border border-line">
          <table className="w-full text-left tabular">
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th className="px-2 py-1 font-medium">Week of</th>
                {series.map((s) => (
                  <th key={s.id} className="px-2 py-1 text-right font-medium">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {x.map((d, i) => (
                <tr key={d} className="border-t border-line">
                  <td className="px-2 py-1">{fmt.date(d)}</td>
                  {series.map((s) => (
                    <td key={s.id} className="px-2 py-1 text-right">{fmt.int(s.values[i] ?? 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
