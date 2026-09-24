import Anthropic from "@anthropic-ai/sdk";
import { queryWithColumns, type Row } from "./db";
import { guardSql, MAX_ROWS, withRowLimit } from "./sqlGuard";

/**
 * "Ask the data" agent.
 *
 * Claude gets one tool, `run_sql`, and a description of the marts. It plans a
 * query, runs it, reads the result (or the error), and iterates until it can
 * answer in plain English. Every query passes through the SQL guard first and
 * the loop is capped, so a confused model can't spin forever or touch anything
 * outside the read-only marts.
 */

export const MAX_TOOL_CALLS = 6;

export type AgentStep = {
  sql: string;
  purpose: string;
  status: "ok" | "rejected" | "error";
  rowCount?: number;
  message?: string;
};

export type AgentResult = {
  answer: string;
  steps: AgentStep[];
  table: { columns: string[]; rows: Row[]; truncated: boolean } | null;
  usage: { input_tokens: number; output_tokens: number };
};

const RUN_SQL_TOOL: Anthropic.Tool = {
  name: "run_sql",
  description:
    "Run one read-only DuckDB SQL query (SELECT or WITH) against the marts schema and get " +
    `back up to ${MAX_ROWS} rows as JSON. Use it to look at data before answering. ` +
    "If the query is rejected or errors, read the message and fix the query.",
  input_schema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "A single DuckDB SELECT/WITH query over marts.* tables." },
      purpose: { type: "string", description: "One short sentence: what this query checks." },
    },
    required: ["sql", "purpose"],
  },
};

export const SCHEMA_DESCRIPTION = `
You can query these DuckDB tables (schema "marts"). All money is NZD. Dates are local NZ dates.

marts.dim_venue(venue_id, venue_name, city, region_code, setting, capacity, latitude, longitude)
  - setting is 'indoor' or 'outdoor'. venue_ids: AKL-AQ (aquarium, Auckland), ZQN-AP (adventure
    park, Queenstown), WLG-SM (science museum, Wellington), CHC-BG (botanic gardens, Christchurch).

marts.dim_date(date, year, month, month_name, week_start, iso_day_of_week, day_name, is_weekend, season)
  - season uses southern-hemisphere seasons (summer = Dec-Feb).

marts.fct_daily_venue — one row per venue per day:
  (venue_id, date, visitors, revenue_nzd, revenue_per_visitor_nzd, online_share, child_share,
   utilisation, temp_max_c, precipitation_mm, weather_band, holiday_name, is_public_holiday,
   is_weekend, day_name, season)
  - weather_band: 'dry' (<1mm), 'showers' (1-5mm), 'wet' (>=5mm), 'unknown'.
  - is_public_holiday includes regional anniversary days for that venue's region.
  - online_share, child_share and utilisation are fractions 0-1.

marts.fct_ticket_sales — one row per venue/day/ticket type/channel:
  (record_id, venue_id, date, ticket_type, channel, quantity, gross_amount_nzd)
  - ticket_type: adult, child, senior, annual_pass. channel: online, walk_up, partner.
`.trim();

const SYSTEM_PROMPT = `You are a data analyst for a group of New Zealand visitor attractions.
Answer the user's question using the run_sql tool against the warehouse described below.

${SCHEMA_DESCRIPTION}

Rules:
- Always check the numbers with run_sql before answering; never guess figures.
- Prefer one well-aimed query; use a follow-up only if the first result raises a real question.
- Aggregate in SQL. Round money to whole dollars and percentages to one decimal place.
- Compare like with like (e.g. holidays vs ordinary weekdays, not vs all days) and say what you compared.
- If the data can't answer the question, say so plainly and suggest what would.
- Reply in 2-5 sentences of plain English. Don't paste SQL in the answer; the UI shows it separately.`;

type RunQuery = typeof queryWithColumns;

export async function askAgent(
  question: string,
  opts: { client?: Anthropic; model?: string; runQuery?: RunQuery } = {},
): Promise<AgentResult> {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
  const runQuery = opts.runQuery ?? queryWithColumns;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const steps: AgentStep[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let table: AgentResult["table"] = null;

  for (let turn = 0; turn <= MAX_TOOL_CALLS; turn++) {
    const forceAnswer = steps.length >= MAX_TOOL_CALLS;
    const response = await client.messages.create({
      model,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: [RUN_SQL_TOOL],
      tool_choice: forceAnswer ? { type: "none" } : { type: "auto" },
      messages,
    });
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (forceAnswer || response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const answer = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { answer: answer || "I couldn't produce an answer.", steps, table, usage };
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const input = use.input as { sql?: string; purpose?: string };
      const step: AgentStep = { sql: input.sql ?? "", purpose: input.purpose ?? "", status: "ok" };
      steps.push(step);

      const guarded = guardSql(step.sql);
      if (!guarded.ok) {
        step.status = "rejected";
        step.message = guarded.reason;
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: guarded.reason });
        continue;
      }
      try {
        const { columns, rows } = await runQuery(withRowLimit(guarded.sql));
        const truncated = rows.length > MAX_ROWS;
        const kept = rows.slice(0, MAX_ROWS);
        step.rowCount = kept.length;
        table = { columns, rows: kept, truncated };
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify({ columns, rows: kept, truncated }),
        });
      } catch (err) {
        step.status = "error";
        step.message = err instanceof Error ? err.message : String(err);
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: step.message });
      }
    }
    messages.push({ role: "user", content: results });
  }

  return { answer: "I ran out of steps before reaching an answer.", steps, table, usage };
}
