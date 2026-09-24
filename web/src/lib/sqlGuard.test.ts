import { describe, expect, it } from "vitest";
import { guardSql, withRowLimit } from "./sqlGuard";

const allowed = [
  "SELECT venue_id, sum(visitors) FROM marts.fct_daily_venue GROUP BY 1",
  "select * from marts.dim_venue;",
  `WITH wet AS (SELECT * FROM marts.fct_daily_venue WHERE weather_band = 'wet')
   SELECT venue_id, avg(visitors) FROM wet GROUP BY ALL`,
  // keywords inside string literals are fine
  "SELECT * FROM marts.fct_daily_venue WHERE holiday_name = 'Drop-in; delete day'",
  "SELECT count(*) AS offset_count FROM marts.dim_date -- how many days?",
];

const blocked: [string, RegExp][] = [
  ["DROP TABLE marts.fct_daily_venue", /SELECT or WITH/],
  ["SELECT 1; DROP TABLE marts.dim_venue", /single statement/],
  ["WITH x AS (DELETE FROM marts.dim_venue RETURNING *) SELECT * FROM x", /DELETE/],
  ["SELECT * FROM read_csv('/etc/passwd')", /read_csv/],
  ["SELECT * FROM '/etc/passwd'", /Reading files/],
  ["SELECT getenv('ANTHROPIC_API_KEY')", /getenv/],
  ["SELECT * FROM raw.ticket_sales", /raw/],
  ["SELECT * FROM information_schema.tables", /information_schema/],
  ["SELECT * FROM duckdb_settings()", /duckdb_settings/],
  ["select 1 /* sneaky */ ; attach 'x.db'", /single statement/],
  ["", /Empty/],
];

describe("guardSql", () => {
  it.each(allowed)("allows %s", (sql) => {
    expect(guardSql(sql).ok).toBe(true);
  });

  it.each(blocked)("blocks %s", (sql, reason) => {
    const result = guardSql(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it("strips a single trailing semicolon", () => {
    expect(guardSql("SELECT * FROM marts.dim_venue; ")).toEqual({
      ok: true,
      sql: "SELECT * FROM marts.dim_venue",
    });
  });
});

describe("withRowLimit", () => {
  it("wraps the query and fetches one extra row to detect truncation", () => {
    expect(withRowLimit("SELECT 1", 10)).toBe("SELECT * FROM (\nSELECT 1\n) AS agent_query LIMIT 11");
  });
});
