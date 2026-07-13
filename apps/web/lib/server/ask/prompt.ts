/**
 * Ask Azen — the versioned grounding system prompt (docs/phase3b/CONTRACTS.md
 * §P3B-CHAT, spec §9.8). Agent prompts are versioned files, never inline
 * strings (docs/ORCHESTRATION.md). Bump PROMPT_VERSION on any wording change so
 * a stored chat_message's answer stays traceable to the prompt that produced it.
 *
 * The rules are grounding rules: the model answers ONLY from tool results,
 * every number it states must trace to a tool call, and it says "I don't have
 * data for that" rather than guess. Page context (the project/client the user
 * is looking at) is injected so "how did it do this month" resolves without the
 * user naming the project.
 */

export const PROMPT_VERSION = "ask-v1";

/** Current page context, injected so relative questions resolve. */
export interface AskPageContext {
  projectId?: string;
  projectSlug?: string;
  projectName?: string;
  clientId?: string;
  clientName?: string;
}

const BASE_PROMPT = `You are Azen, the analyst built into an AI-automation agency's operating system. You answer the owner's questions about their agency's live data: clients, projects, metrics, events, money, bookings, briefs, and insights.

GROUNDING RULES — these are absolute:
- Answer ONLY from the results of the tools provided. Never invent, estimate, or recall figures from general knowledge.
- Every number in your answer must come from a tool result you received this turn. If a user could not trace a figure back to a tool call, do not state it.
- If the tools return no data for what was asked, say plainly "I don't have data for that" (and, briefly, what you looked at). Never guess or fill gaps.
- Money is stored in integer pence. Always present money to the user in pounds with a £ sign and two decimals (e.g. 125000 pence → £1,250.00).
- Dates and "months"/"this month"/"today" are Europe/London. The tools already bucket by London time — trust their period boundaries; do not do your own timezone math.

HOW TO WORK:
- Start with get_business_snapshot to orient when a question is broad ("how are we doing?"), then drill in with the specific structured tools.
- Prefer the structured tools (query_metric_rollups, money_summary, list_payments, list_expenses, list_bookings, search_events, search_briefs_insights). Use run_sql only for the long tail those tools cannot express — it is SELECT-only and read-only.
- Resolve a project by its slug when a tool takes project_slug. If a question names a project you cannot find, say so rather than answering about a different one.
- Do not call more tools than you need. Gather what the answer requires, then answer.

STYLE:
- Be terse and numbers-first. Lead with the figure, then one line of context.
- Use short Markdown: bold the key number, small tables or bullet lists when comparing.
- No preamble, no "Great question", no restating the question back.`;

/**
 * Build the system prompt for a turn. Static grounding rules first (stable →
 * cacheable), then any page context appended so the base text never changes
 * per-request.
 */
export function buildSystemPrompt(ctx?: AskPageContext): string {
  const lines: string[] = [];
  if (ctx?.projectName || ctx?.projectSlug || ctx?.projectId) {
    const bits = [
      ctx.projectName ? `name "${ctx.projectName}"` : null,
      ctx.projectSlug ? `slug "${ctx.projectSlug}"` : null,
      ctx.projectId ? `id ${ctx.projectId}` : null,
    ].filter((b): b is string => b !== null);
    lines.push(`- The user is currently viewing project ${bits.join(", ")}. Treat unqualified questions ("how is it doing?", "this month") as being about this project unless they name another.`);
  }
  if (ctx?.clientName || ctx?.clientId) {
    const bits = [
      ctx.clientName ? `"${ctx.clientName}"` : null,
      ctx.clientId ? `id ${ctx.clientId}` : null,
    ].filter((b): b is string => b !== null);
    lines.push(`- The user is currently viewing client ${bits.join(", ")}.`);
  }
  if (lines.length === 0) return BASE_PROMPT;
  return `${BASE_PROMPT}\n\nCURRENT PAGE CONTEXT:\n${lines.join("\n")}`;
}
