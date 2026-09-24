import Link from "next/link";
import type { Dashboard, Venue } from "@/lib/queries";
import { fmt, VENUE_SLOT } from "@/lib/format";
import { AskPanel } from "./AskPanel";
import { ChangeBars } from "./ChangeBars";
import { KpiTiles } from "./KpiTiles";
import { LineChart } from "./LineChart";

type Props = { data: Dashboard; venues: Venue[]; venue: string };

export function DashboardView({ data, venues, venue }: Props) {
  const nameOf = Object.fromEntries(venues.map((v) => [v.venue_id, v.venue_name]));

  // Pivot long weekly rows into one series per venue.
  const weeks = [...new Set(data.weekly.map((r) => r.week_start))].sort();
  const weekIndex = new Map(weeks.map((w, i) => [w, i]));
  const shown = venue === "ALL" ? venues : venues.filter((v) => v.venue_id === venue);
  const series = shown.map((v) => {
    const values = new Array(weeks.length).fill(0);
    data.weekly.filter((r) => r.venue_id === v.venue_id).forEach((r) => (values[weekIndex.get(r.week_start)!] = r.visitors));
    return { id: v.venue_id, label: v.venue_name, shortLabel: v.city, slot: VENUE_SLOT[v.venue_id] ?? "series-1", values };
  });

  const weatherRows = data.weather.map((w) => ({
    id: w.venue_id,
    label: w.venue_name,
    tag: w.setting === "indoor" ? "Indoor" : "Outdoor",
    change: w.dry_avg ? w.wet_avg / w.dry_avg - 1 : 0,
    detail: [
      ["Dry-day average", fmt.int(w.dry_avg)],
      ["Wet-day average", fmt.int(w.wet_avg)],
      ["Wet days (≥5 mm)", String(w.wet_days)],
    ] as [string, string][],
  }));

  const holidayRows = data.holidays.map((h) => ({
    id: h.venue_id,
    label: h.venue_name,
    change: h.weekday_avg ? h.holiday_avg / h.weekday_avg - 1 : 0,
    detail: [
      ["Public-holiday average", fmt.int(h.holiday_avg)],
      ["Ordinary weekday average", fmt.int(h.weekday_avg)],
      ["Holidays in period", String(h.holiday_days)],
    ] as [string, string][],
  }));

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Visitor Insights</h1>
          <p className="mt-1 text-sm text-ink-2">
            Ticketing, weather and public holidays across four NZ attractions ·{" "}
            {data.kpis.first_date && `${fmt.date(data.kpis.first_date)} – ${fmt.date(data.kpis.last_date)}`}
          </p>
        </div>
        {data.freshness && (
          <p className="text-xs text-ink-2">
            <span className={data.freshness.passed === data.freshness.checks ? "text-good-text" : "text-critical"}>
              {data.freshness.passed === data.freshness.checks ? "✓" : "!"} {data.freshness.passed}/{data.freshness.checks} data checks passed
            </span>{" "}
            · pipeline run {data.freshness.finished_at.slice(0, 16)} ({data.freshness.mode})
          </p>
        )}
      </header>

      <nav aria-label="Venue filter" className="mt-6 flex flex-wrap gap-2">
        {[{ venue_id: "ALL", venue_name: "All venues" }, ...venues].map((v) => {
          const active = v.venue_id === venue;
          return (
            <Link
              key={v.venue_id}
              href={v.venue_id === "ALL" ? "/" : `/?venue=${v.venue_id}`}
              aria-current={active ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${
                active ? "border-ink bg-ink text-page" : "border-line text-ink-2 hover:bg-surface"
              }`}
            >
              {v.venue_name}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6">
        <KpiTiles kpis={data.kpis} />
      </div>

      <section className="mt-6 rounded-xl border border-line bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold text-ink">Weekly visitors</h2>
        <p className="mb-4 mt-1 text-sm text-ink-2">Complete weeks only. Hover for weekly figures.</p>
        <LineChart x={weeks} series={series} />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
          <h2 className="text-base font-semibold text-ink">Rain moves people indoors</h2>
          <p className="mb-4 mt-1 text-sm text-ink-2">Average visitors on wet days compared with dry days.</p>
          <ChangeBars rows={weatherRows} caption="Wet = 5 mm or more of rain that day at the venue (Open-Meteo)." />
        </section>
        <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
          <h2 className="text-base font-semibold text-ink">Public-holiday uplift</h2>
          <p className="mb-4 mt-1 text-sm text-ink-2">Average visitors on public holidays compared with ordinary weekdays.</p>
          <ChangeBars
            rows={holidayRows}
            caption="Includes regional anniversary days, matched to each venue's region."
          />
        </section>
      </div>

      <div className="mt-6">
        <AskPanel />
      </div>

      <footer className="mt-10 text-xs text-muted">
        Venues are fictional. Weather: Open-Meteo. Holidays: Nager.Date. Ticket sales come from a simulated vendor API.
        {venue !== "ALL" && nameOf[venue] ? ` Showing ${nameOf[venue]}.` : ""}
      </footer>
    </main>
  );
}
