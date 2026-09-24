import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { askAgent, MAX_TOOL_CALLS } from "./agent";

type Reply = { stop_reason: string; content: unknown[] };

/** A scripted stand-in for the Anthropic client that records what it was sent. */
function fakeClient(replies: Reply[]) {
  const sent: { messages: Anthropic.MessageParam[]; tool_choice: unknown }[] = [];
  let i = 0;
  const client = {
    messages: {
      create: async (req: { messages: Anthropic.MessageParam[]; tool_choice: unknown }) => {
        sent.push({ messages: structuredClone(req.messages), tool_choice: req.tool_choice });
        const reply = replies[Math.min(i++, replies.length - 1)];
        return { ...reply, usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}

const toolUse = (id: string, sql: string) => ({
  type: "tool_use", id, name: "run_sql", input: { sql, purpose: "test" },
});
const text = (t: string) => ({ type: "text", text: t });

describe("askAgent", () => {
  it("runs the model's query and returns its answer with the result table", async () => {
    const { client, sent } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t1", "SELECT venue_id FROM marts.dim_venue")] },
      { stop_reason: "end_turn", content: [text("There are four venues.")] },
    ]);
    const executed: string[] = [];
    const result = await askAgent("How many venues?", {
      client,
      runQuery: async (sql) => {
        executed.push(sql);
        return { columns: ["venue_id"], rows: [{ venue_id: "AKL-AQ" }, { venue_id: "ZQN-AP" }] };
      },
    });

    expect(result.answer).toBe("There are four venues.");
    expect(result.steps).toEqual([
      { sql: "SELECT venue_id FROM marts.dim_venue", purpose: "test", status: "ok", rowCount: 2 },
    ]);
    expect(executed[0]).toMatch(/LIMIT 201$/); // row cap applied
    expect(result.table?.rows.length).toBe(2);
    const toolResult = (sent[1].messages[2].content as Anthropic.ToolResultBlockParam[])[0];
    expect(toolResult.tool_use_id).toBe("t1");
    expect(result.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
  });

  it("never executes rejected SQL and tells the model why", async () => {
    const { client, sent } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t1", "DROP TABLE marts.dim_venue")] },
      { stop_reason: "end_turn", content: [text("I can only read data.")] },
    ]);
    let ran = false;
    const result = await askAgent("Delete everything", {
      client,
      runQuery: async () => {
        ran = true;
        return { columns: [], rows: [] };
      },
    });
    expect(ran).toBe(false);
    expect(result.steps[0].status).toBe("rejected");
    const toolResult = (sent[1].messages[2].content as Anthropic.ToolResultBlockParam[])[0];
    expect(toolResult.is_error).toBe(true);
  });

  it("feeds database errors back so the model can correct itself", async () => {
    const { client } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t1", "SELECT nope FROM marts.dim_venue")] },
      { stop_reason: "tool_use", content: [toolUse("t2", "SELECT venue_id FROM marts.dim_venue")] },
      { stop_reason: "end_turn", content: [text("Fixed it.")] },
    ]);
    const result = await askAgent("q", {
      client,
      runQuery: async (sql) => {
        if (sql.includes("nope")) throw new Error('Binder Error: column "nope" not found');
        return { columns: ["venue_id"], rows: [{ venue_id: "AKL-AQ" }] };
      },
    });
    expect(result.steps.map((s) => s.status)).toEqual(["error", "ok"]);
    expect(result.answer).toBe("Fixed it.");
  });

  it("stops calling tools after the step budget and forces an answer", async () => {
    const { client, sent } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t", "SELECT 1")] },
    ]);
    const result = await askAgent("loop forever", {
      client,
      runQuery: async () => ({ columns: ["x"], rows: [{ x: 1 }] }),
    });
    expect(result.steps.length).toBe(MAX_TOOL_CALLS);
    expect(sent[sent.length - 1].tool_choice).toEqual({ type: "none" });
  });
});
