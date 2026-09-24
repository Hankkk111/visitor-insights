const int = new Intl.NumberFormat("en-NZ", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-NZ", { notation: "compact", maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD", maximumFractionDigits: 0 });
const moneyCents = new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyCompact = new Intl.NumberFormat("en-NZ", {
  style: "currency", currency: "NZD", notation: "compact", maximumFractionDigits: 1,
});

export const fmt = {
  int: (v: number) => int.format(v),
  compact: (v: number) => compact.format(v),
  nzd: (v: number) => money.format(v),
  nzdCents: (v: number) => moneyCents.format(v),
  nzdCompact: (v: number) => moneyCompact.format(v),
  pct: (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`,
  signedPct: (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(0)}%`,
  date: (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }),
  shortDate: (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString("en-NZ", { day: "numeric", month: "short" }),
};

/** Venue colour slots are fixed by id so a filter never repaints a venue. */
export const VENUE_SLOT: Record<string, string> = {
  "AKL-AQ": "series-1",
  "CHC-BG": "series-2",
  "WLG-SM": "series-3",
  "ZQN-AP": "series-4",
};

/** "Nice" axis ticks: 0 .. max rounded up to 1/2/2.5/5 x 10^n steps. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step * 0.001; t += step) ticks.push(t);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}
