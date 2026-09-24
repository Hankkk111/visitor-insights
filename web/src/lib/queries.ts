import { query } from "./db";

/**
 * Dashboard queries. SQL is kept in named constants so it can be read, reviewed
 * and tested on its own. `$1` is always the venue filter ('ALL' or a venue_id).
 */

export const SQL = {
  venues: `
    SELECT venue_id, venue_name, city, setting, capacity
    FROM marts.dim_venue ORDER BY venue_id`,

  kpis: `
    SELECT
      CAST(sum(visitors) AS DOUBLE)                                   AS visitors,
      CAST(sum(revenue_nzd) AS DOUBLE)                                AS revenue_nzd,
      CAST(sum(revenue_nzd) / nullif(sum(visitors), 0) AS DOUBLE)     AS revenue_per_visitor,
      CAST(sum(visitors * online_share) / nullif(sum(visitors), 0) AS DOUBLE) AS online_share,
      CAST(avg(utilisation) AS DOUBLE)                                AS avg_utilisation,
      CAST(min(date) AS VARCHAR)                                      AS first_date,
      CAST(max(date) AS VARCHAR)                                      AS last_date
    FROM marts.fct_daily_venue
    WHERE $1 = 'ALL' OR venue_id = $1`,

  weeklyVisitors: `
    SELECT CAST(d.week_start AS VARCHAR) AS week_start, f.venue_id,
           CAST(sum(f.visitors) AS DOUBLE) AS visitors
    FROM marts.fct_daily_venue f
    JOIN marts.dim_date d USING (date)
    WHERE $1 = 'ALL' OR f.venue_id = $1
    GROUP BY ALL
    -- drop partial weeks at either end so the line doesn't dip artificially
    HAVING count(DISTINCT f.date) = 7
    ORDER BY week_start, f.venue_id`,

  weatherImpact: `
    SELECT f.venue_id, v.venue_name, v.setting,
           CAST(avg(visitors) FILTER (WHERE weather_band = 'dry') AS DOUBLE) AS dry_avg,
           CAST(avg(visitors) FILTER (WHERE weather_band = 'wet') AS DOUBLE) AS wet_avg,
           CAST(count(*) FILTER (WHERE weather_band = 'wet') AS INTEGER)     AS wet_days
    FROM marts.fct_daily_venue f
    JOIN marts.dim_venue v USING (venue_id)
    WHERE $1 = 'ALL' OR f.venue_id = $1
    GROUP BY ALL
    ORDER BY f.venue_id`,

  // Compare holidays with ordinary weekdays so weekend effects don't inflate the uplift.
  holidayUplift: `
    SELECT f.venue_id, v.venue_name,
           CAST(avg(visitors) FILTER (WHERE is_public_holiday) AS DOUBLE)                    AS holiday_avg,
           CAST(avg(visitors) FILTER (WHERE NOT is_public_holiday AND NOT is_weekend) AS DOUBLE) AS weekday_avg,
           CAST(count(*) FILTER (WHERE is_public_holiday) AS INTEGER)                        AS holiday_days
    FROM marts.fct_daily_venue f
    JOIN marts.dim_venue v USING (venue_id)
    WHERE $1 = 'ALL' OR f.venue_id = $1
    GROUP BY ALL
    ORDER BY f.venue_id`,

  // ops.* lives only in the local warehouse; the dashboard hides this when unavailable.
  freshness: `
    SELECT r.run_id, r.mode, CAST(r.finished_at AS VARCHAR) AS finished_at,
           CAST(count(q.check_name) AS INTEGER)                  AS checks,
           CAST(count(*) FILTER (WHERE q.passed) AS INTEGER)     AS passed
    FROM ops.pipeline_runs r
    LEFT JOIN ops.dq_results q USING (run_id)
    WHERE r.status = 'success'
    GROUP BY r.run_id, r.mode, r.finished_at
    ORDER BY r.finished_at DESC
    LIMIT 1`,
} as const;

export type Venue = { venue_id: string; venue_name: string; city: string; setting: string; capacity: number };
export type Kpis = {
  visitors: number; revenue_nzd: number; revenue_per_visitor: number; online_share: number;
  avg_utilisation: number; first_date: string; last_date: string;
};
export type WeeklyPoint = { week_start: string; venue_id: string; visitors: number };
export type WeatherImpact = {
  venue_id: string; venue_name: string; setting: string; dry_avg: number; wet_avg: number; wet_days: number;
};
export type HolidayUplift = {
  venue_id: string; venue_name: string; holiday_avg: number; weekday_avg: number; holiday_days: number;
};
export type Freshness = { run_id: string; mode: string; finished_at: string; checks: number; passed: number };

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function getVenues(): Promise<Venue[]> {
  const rows = await query(SQL.venues);
  return rows.map((r) => ({ ...(r as Venue), capacity: n(r.capacity) }));
}

export async function getDashboard(venue: string) {
  const [kpiRows, weekly, weather, holidays, freshness] = await Promise.all([
    query(SQL.kpis, [venue]),
    query(SQL.weeklyVisitors, [venue]),
    query(SQL.weatherImpact, [venue]),
    query(SQL.holidayUplift, [venue]),
    query(SQL.freshness).catch(() => []),
  ]);
  const k = kpiRows[0] ?? {};
  return {
    kpis: {
      visitors: n(k.visitors), revenue_nzd: n(k.revenue_nzd),
      revenue_per_visitor: n(k.revenue_per_visitor), online_share: n(k.online_share),
      avg_utilisation: n(k.avg_utilisation),
      first_date: String(k.first_date ?? ""), last_date: String(k.last_date ?? ""),
    } satisfies Kpis,
    weekly: weekly.map((r) => ({ week_start: String(r.week_start), venue_id: String(r.venue_id), visitors: n(r.visitors) })),
    weather: weather.map((r) => ({
      venue_id: String(r.venue_id), venue_name: String(r.venue_name), setting: String(r.setting),
      dry_avg: n(r.dry_avg), wet_avg: n(r.wet_avg), wet_days: n(r.wet_days),
    })),
    holidays: holidays.map((r) => ({
      venue_id: String(r.venue_id), venue_name: String(r.venue_name),
      holiday_avg: n(r.holiday_avg), weekday_avg: n(r.weekday_avg), holiday_days: n(r.holiday_days),
    })),
    freshness: (freshness[0] as Freshness | undefined) ?? null,
  };
}

export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;
