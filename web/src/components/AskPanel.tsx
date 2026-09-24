"use client";

import { useState, type FormEvent } from "react";
import type { AgentResult } from "@/lib/agent";

const EXAMPLES = [
  "Which venue loses the most visitors on wet days?",
  "How much more do we sell on public holidays than normal weekdays?",
  "What share of Queenstown tickets are bought online in summer vs winter?",
  "Which month had the highest revenue per visitor, by venue?",
];

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "done"; result: AgentResult };

export function AskPanel() {
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function ask(q: string) {
    const trimmed = q.trim();
    if (trimmed.length < 3) return;
    setQuestion(trimmed);
    setStatus({ kind: "loading" });
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setStatus({ kind: "done", result: body as AgentResult });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void ask(question);
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <h2 className="text-base font-semibold text-ink">Ask the data</h2>
      <p className="mt-1 text-sm text-ink-2">
        Claude writes and runs read-only SQL against the warehouse, checks the result, then answers.
      </p>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="question" className="sr-only">Question</label>
        <input
          id="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          placeholder="e.g. Which venue is busiest on rainy weekends?"
          className="min-w-0 flex-1 rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-accent"
        />
        <button
          type="submit"
          disabled={status.kind === "loading" || question.trim().length < 3}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {status.kind === "loading" ? "Thinking…" : "Ask"}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => void ask(ex)}
            disabled={status.kind === "loading"}
            className="rounded-full border border-line px-3 py-1 text-xs text-ink-2 hover:bg-page disabled:opacity-50"
          >
            {ex}
          </button>
        ))}
      </div>

      <div aria-live="polite" className="mt-4">
        {status.kind === "error" && <p className="text-sm text-critical">{status.message}</p>}
        {status.kind === "done" && <AgentAnswer result={status.result} />}
      </div>
    </section>
  );
}

function AgentAnswer({ result }: { result: AgentResult }) {
  const { answer, steps, table } = result;
  return (
    <div className="space-y-3">
      <p className="whitespace-pre-line text-sm leading-6 text-ink">{answer}</p>

      {steps.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer select-none text-ink-2">
            {steps.length} {steps.length === 1 ? "query" : "queries"} run
          </summary>
          <ol className="mt-2 space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="rounded-lg border border-line p-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-ink-2">{s.purpose}</span>
                  <span className={s.status === "ok" ? "text-good-text" : "text-critical"}>
                    {s.status === "ok" ? `✓ ${s.rowCount} rows` : `✕ ${s.status}`}
                  </span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-ink">{s.sql}</pre>
                {s.message && <p className="mt-1 text-critical">{s.message}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}

      {table && table.rows.length > 0 && (
        <div className="max-h-72 overflow-auto rounded-lg border border-line">
          <table className="w-full text-left text-xs tabular">
            <thead className="sticky top-0 bg-surface">
              <tr>
                {table.columns.map((c) => (
                  <th key={c} className="px-2 py-1.5 font-medium text-ink-2">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i} className="border-t border-line">
                  {table.columns.map((c) => (
                    <td key={c} className="px-2 py-1 text-ink">{formatCell(row[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {table.truncated && <p className="px-2 py-1 text-muted">Showing the first {table.rows.length} rows.</p>}
        </div>
      )}
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  if (n !== null) return Number.isInteger(n) ? n.toLocaleString("en-NZ") : n.toLocaleString("en-NZ", { maximumFractionDigits: 2 });
  return String(v);
}
