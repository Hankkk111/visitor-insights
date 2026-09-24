"use client";

import { useState } from "react";
import { fmt } from "@/lib/format";

export type ChangeRow = {
  id: string;
  label: string;
  tag?: string;
  change: number; // fractional change, e.g. 0.19 = +19%
  detail: [string, string][]; // tooltip rows: [label, value]
};

/**
 * Horizontal bars for a signed % change per venue. Positive and negative use the two
 * poles of a diverging pair around a neutral zero line; the value is always printed
 * next to the bar, so colour never carries the meaning alone.
 */
export function ChangeBars({ rows, caption }: { rows: ChangeRow[]; caption: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const hasNegative = rows.some((r) => r.change < 0);
  const extent = Math.max(0.05, ...rows.map((r) => Math.abs(r.change)));
  const zero = hasNegative ? 50 : 0; // % across the track where zero sits
  const scale = (hasNegative ? 36 : 80) / extent; // leave room for the value label

  return (
    <figure>
      <ul className="space-y-3">
        {rows.map((r) => {
          const width = Math.abs(r.change) * scale;
          const positive = r.change >= 0;
          return (
            <li
              key={r.id}
              className="relative grid grid-cols-1 items-center gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,13rem)_1fr]"
              onPointerEnter={() => setHover(r.id)}
              onPointerLeave={() => setHover(null)}
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-ink">
                  {r.label}
                  {r.tag && <span className="ml-2 text-xs text-muted sm:hidden">{r.tag}</span>}
                </div>
                {r.tag && <div className="hidden text-xs text-muted sm:block">{r.tag}</div>}
              </div>
              <div className="relative h-7">
                {hasNegative && (
                  <div className="absolute inset-y-0 w-px bg-[var(--axis)]" style={{ left: `${zero}%` }} aria-hidden />
                )}
                <div
                  className="absolute top-1.5 h-4"
                  style={{
                    left: positive ? `${zero}%` : `${zero - width}%`,
                    width: `${width}%`,
                    background: positive ? "var(--pos)" : "var(--neg)",
                    borderRadius: positive ? "0 4px 4px 0" : "4px 0 0 4px",
                  }}
                  aria-hidden
                />
                <span
                  className="tabular absolute top-1 text-sm font-medium text-ink"
                  style={
                    positive
                      ? { left: `calc(${zero + width}% + 6px)` }
                      : { right: `calc(${100 - zero + width}% + 6px)` }
                  }
                >
                  {fmt.signedPct(r.change)}
                </span>
              </div>
              {hover === r.id && (
                <div className="pointer-events-none absolute left-0 top-full z-10 mt-1 min-w-52 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md sm:left-52">
                  <div className="mb-1 font-medium text-ink">{r.label}</div>
                  {r.detail.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-4">
                      <span className="text-ink-2">{k}</span>
                      <span className="tabular text-ink">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <figcaption className="mt-3 text-xs text-muted">{caption}</figcaption>
    </figure>
  );
}
