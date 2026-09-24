import path from "node:path";
import type { DuckDBInstance } from "@duckdb/node-api";

/**
 * Server-only DuckDB access.
 *
 * Locally this opens the pipeline's warehouse file READ_ONLY with external access
 * disabled (no reading arbitrary files, no extensions). In production it points at
 * MotherDuck when MOTHERDUCK_TOKEN is set, using a read-scoped token.
 */

export type Row = Record<string, unknown>;
export type Param = string | number | boolean;

function target(): { location: string; options: Record<string, string> } {
  if (process.env.MOTHERDUCK_TOKEN) {
    const db = process.env.MOTHERDUCK_DATABASE ?? "visitor_insights";
    // Serverless functions have no HOME and only a writable /tmp. DuckDB reads HOME
    // while opening the MotherDuck connection, before config options apply, so set it
    // here as well as passing the options.
    if (!process.env.HOME || process.env.VERCEL) process.env.HOME = "/tmp";
    return {
      location: `md:${db}`,
      options: { home_directory: "/tmp", extension_directory: "/tmp/duckdb_extensions" },
    };
  }
  const file =
    process.env.DUCKDB_PATH ||
    path.resolve(process.cwd(), "..", "pipeline", "data", "warehouse.duckdb");
  return {
    location: file,
    options: {
      access_mode: "READ_ONLY",
      enable_external_access: "false",
      lock_configuration: "true",
    },
  };
}

let instance: Promise<DuckDBInstance> | null = null;

function getInstance(): Promise<DuckDBInstance> {
  if (!instance) {
    const { location, options } = target();
    // Loaded lazily so a missing native binding surfaces as a catchable error.
    instance = import("@duckdb/node-api")
      .then(({ DuckDBInstance }) => DuckDBInstance.fromCache(location, options))
      .catch((err) => {
        instance = null; // allow a retry once the file exists
        throw err;
      });
  }
  return instance;
}

export async function query<T extends Row = Row>(sql: string, params: Param[] = []): Promise<T[]> {
  const { rows } = await queryWithColumns(sql, params);
  return rows as T[];
}

export async function queryWithColumns(
  sql: string,
  params: Param[] = [],
): Promise<{ columns: string[]; rows: Row[] }> {
  const connection = await (await getInstance()).connect();
  try {
    const reader = await connection.runAndReadAll(sql, params);
    return { columns: reader.columnNames(), rows: reader.getRowObjectsJson() as Row[] };
  } finally {
    connection.closeSync();
  }
}
