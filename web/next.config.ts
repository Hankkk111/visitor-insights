import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DuckDB ships a native binding; keep it out of the server bundle.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  // The binding is picked per platform at runtime, so file tracing can't see it.
  // Ship the Linux builds explicitly for serverless deployments.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/@duckdb/node-bindings-linux-x64/**",
      "./node_modules/@duckdb/node-bindings-linux-arm64/**",
    ],
  },
};

export default nextConfig;
