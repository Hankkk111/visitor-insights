import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DuckDB ships a native binding; keep it out of the server bundle.
  serverExternalPackages: ["@duckdb/node-api"],
};

export default nextConfig;
