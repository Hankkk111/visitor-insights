import { NextResponse } from "next/server";
import { askAgent } from "@/lib/agent";

export const runtime = "nodejs"; // DuckDB's native binding needs Node, not the edge runtime

// Small per-IP limiter so a public demo can't run up an API bill.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 8;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_REQUESTS;
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL) {
    return NextResponse.json(
      { error: "The question box is switched off: ANTHROPIC_API_KEY / ANTHROPIC_MODEL are not configured." },
      { status: 503 },
    );
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many questions, try again in a minute." }, { status: 429 });
  }

  let question: unknown;
  try {
    ({ question } = await request.json());
  } catch {
    return NextResponse.json({ error: "Send JSON: { \"question\": \"...\" }" }, { status: 400 });
  }
  if (typeof question !== "string" || question.trim().length < 3 || question.length > 500) {
    return NextResponse.json({ error: "Ask a question between 3 and 500 characters." }, { status: 400 });
  }

  try {
    const result = await askAgent(question.trim());
    return NextResponse.json(result);
  } catch (err) {
    console.error("ask failed", err);
    return NextResponse.json({ error: "The agent failed to answer. Please try again." }, { status: 502 });
  }
}
