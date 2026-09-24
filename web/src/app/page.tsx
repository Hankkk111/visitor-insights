import { DashboardView } from "@/components/DashboardView";
import { getDashboard, getVenues } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ venue?: string }> }) {
  const { venue: requested } = await searchParams;

  let venues;
  try {
    venues = await getVenues();
  } catch (err) {
    console.error("warehouse unavailable", err);
    return <SetupNotice error={err instanceof Error ? err.message : String(err)} />;
  }

  // Only accept known venue ids; anything else falls back to all venues.
  const venue = venues.some((v) => v.venue_id === requested) ? requested! : "ALL";
  let data;
  try {
    data = await getDashboard(venue);
  } catch (err) {
    console.error("dashboard query failed", err);
    return <SetupNotice error={err instanceof Error ? err.message : String(err)} />;
  }
  return <DashboardView data={data} venues={venues} venue={venue} />;
}

function SetupNotice({ error }: { error: string }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-xl font-semibold text-ink">Data is unavailable</h1>
      <p className="mt-2 text-sm text-ink-2">
        The warehouse could not be reached. In production, check MOTHERDUCK_TOKEN and
        MOTHERDUCK_DATABASE. Locally, build it with the pipeline and reload:
      </p>
      <pre className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface p-4 text-sm text-ink">
        {`cd pipeline\npip install -e ".[dev]"\nvisitor-pipeline run --mode offline`}
      </pre>
      <p className="mt-4 text-xs text-muted">Details: {error}</p>
    </main>
  );
}
