/**
 * Guardrails for SQL written by the LLM agent.
 *
 * This is one layer of several (see README "Security"): the database is also
 * opened READ_ONLY with external access disabled, and results are row-capped.
 * The guard's job is to reject anything that isn't a single read-only query
 * over the analytics marts, and to give the agent a clear reason so it can fix
 * its own query.
 */

export const MAX_ROWS = 200;

const FORBIDDEN_KEYWORDS = [
  "attach", "detach", "copy", "export", "import", "install", "load", "pragma",
  "create", "insert", "update", "delete", "drop", "alter", "truncate", "merge",
  "set", "reset", "call", "checkpoint", "vacuum", "begin", "commit", "rollback",
  "use", "grant", "revoke", "secret",
];

// Table/scalar functions that read files, env vars or run nested SQL.
const FORBIDDEN_FUNCTIONS =
  /\b(read_\w+|\w+_scan|glob|getenv|query|query_table|sniff_csv|duckdb_\w+|pragma_\w+|current_setting)\s*\(/i;

// Only the marts schema is exposed to the agent.
const FORBIDDEN_SCHEMAS =
  /\b(raw|staging|ops|main|information_schema|pg_catalog|system|temp)\s*\./i;

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

/** Remove comments and blank out string literals so keyword checks can't be fooled. */
export function stripForAnalysis(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

export function guardSql(input: string): GuardResult {
  const raw = input.trim().replace(/;\s*$/, "");
  if (!raw) return { ok: false, reason: "Empty query." };
  if (raw.length > 5000) return { ok: false, reason: "Query is too long (max 5000 characters)." };

  const analysed = stripForAnalysis(raw).trim();

  if (analysed.includes(";")) {
    return { ok: false, reason: "Only a single statement is allowed." };
  }
  if (!/^(select|with)\b/i.test(analysed)) {
    return { ok: false, reason: "Query must start with SELECT or WITH." };
  }
  const keyword = FORBIDDEN_KEYWORDS.find((k) => new RegExp(`\\b${k}\\b`, "i").test(analysed));
  if (keyword) {
    return { ok: false, reason: `Keyword "${keyword.toUpperCase()}" is not allowed; queries are read-only.` };
  }
  const fn = analysed.match(FORBIDDEN_FUNCTIONS);
  if (fn) return { ok: false, reason: `Function "${fn[1]}" is not allowed.` };

  // FROM 'some/file.csv' is DuckDB shorthand for reading a file.
  if (/\b(from|join)\s*'/i.test(stripComments(raw))) {
    return { ok: false, reason: "Reading files is not allowed; query the marts.* tables." };
  }
  const schema = analysed.match(FORBIDDEN_SCHEMAS);
  if (schema) {
    return { ok: false, reason: `Schema "${schema[1]}" is not available; use marts.* tables only.` };
  }

  return { ok: true, sql: raw };
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Wrap an approved query so it can never return more than MAX_ROWS (+1 to detect truncation). */
export function withRowLimit(sql: string, maxRows = MAX_ROWS): string {
  return `SELECT * FROM (\n${sql}\n) AS agent_query LIMIT ${maxRows + 1}`;
}
