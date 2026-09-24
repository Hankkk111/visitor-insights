import type { Kpis } from "@/lib/queries";
import { fmt } from "@/lib/format";

export function KpiTiles({ kpis }: { kpis: Kpis }) {
  const tiles = [
    { label: "Visitors", value: fmt.int(kpis.visitors), note: `${fmt.pct(kpis.avg_utilisation)} average capacity used` },
    { label: "Ticket revenue", value: fmt.nzdCompact(kpis.revenue_nzd), note: fmt.nzd(kpis.revenue_nzd) },
    { label: "Revenue per visitor", value: fmt.nzdCents(kpis.revenue_per_visitor), note: "incl. annual-pass entries" },
    { label: "Booked online", value: fmt.pct(kpis.online_share, 1), note: "share of visitors" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-line bg-surface p-4">
          <dt className="text-xs font-medium text-ink-2">{t.label}</dt>
          <dd className="mt-1 text-2xl font-semibold tracking-tight text-ink">{t.value}</dd>
          <dd className="mt-1 text-xs text-muted">{t.note}</dd>
        </div>
      ))}
    </dl>
  );
}
