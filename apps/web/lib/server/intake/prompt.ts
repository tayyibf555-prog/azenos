import { projectStack, projectType } from "@azen/db";
import { EVENT_TYPES } from "@azen/events";
import { GOAL_METRICS, type ClientRef, type ProjectDraft } from "./schema";

/**
 * Versioned intake prompt (spec §13 "agent prompts are versioned files").
 * Bump PROMPT_VERSION on any wording change so agent_runs can be correlated to
 * the exact prompt that produced a draft.
 */
export const PROMPT_VERSION = "intake-2026-07-12";

export interface PromptContext {
  clients: ReadonlyArray<ClientRef>;
}

const ENUM_LINE = (label: string, values: readonly string[]): string =>
  `${label}: ${values.join(", ")}`;

function clientsBlock(clients: ReadonlyArray<ClientRef>): string {
  if (clients.length === 0) {
    return "This agency has no existing clients yet — every draft must use client.match=\"new\".";
  }
  const lines = clients.map(
    (c) =>
      `- id=${c.id} · name="${c.name}"${c.industrySlug ? ` · industry=${c.industrySlug}` : ""}`,
  );
  return [
    "Existing clients (propose match=\"existing\" with the EXACT id below only when the call clearly refers to one of these; otherwise match=\"new\"):",
    ...lines,
  ].join("\n");
}

function sharedRules(): string {
  return [
    "# Azen OS — transcript intake co-pilot",
    "",
    "You turn a sales / discovery call transcript into a structured project draft for Azen OS, an operating system a UK AI-automation agency uses to run client projects. Be decisive but honest: infer sensible defaults, and record every inference.",
    "",
    "## Output rules",
    "- Return ONLY the structured object requested (the schema is enforced).",
    `- ${ENUM_LINE("Project type must be one of", projectType.enumValues)}.`,
    `- ${ENUM_LINE("Project stack must be one of", projectStack.enumValues)} (default custom_code unless a no-code tool like GoHighLevel/GHL → ghl, or n8n → n8n, or a blend → mixed).`,
    "- description: 1–2 crisp, client-facing sentences describing what the system does.",
    "",
    "## Client matching",
    "- match=\"existing\" ONLY with an exact id from the list below; copy the id verbatim, never invent one.",
    "- Otherwise match=\"new\" with clientId=null and your best guess at the client's name + a kebab-case industrySlug (e.g. \"dental\", \"home-services\", \"real-estate\"), or null industry if unclear.",
    "",
    "## Money (all amounts are integer PENCE, UK £)",
    "- Convert every £ figure heard in the call to pence: £1,500/month retainer → retainerPenceMonthly=150000; a £4k build fee → buildFeePence=400000; £30/hour value-of-time → hourlyRatePence=3000.",
    "- Use null (not 0) for any money field the call does not mention. Do not fabricate figures — an unmentioned amount is null and belongs in assumptions if you think it matters.",
    "",
    "## Goals (≤5)",
    "- Each goal = { metric, target (number), period: day|week|month }.",
    "- metric MUST be one of these Azen metric keys:",
    ...GOAL_METRICS.map((m) => `    - ${m.key} — ${m.label}`),
    "- Only add a goal when the call implies a concrete target (e.g. \"book 20 appointments a week\" → { metric: \"bookings_created\", target: 20, period: \"week\" }).",
    "",
    "## Suggested event types",
    "- suggestedEventTypes: pick the taxonomy event types this system will emit, from:",
    `    ${EVENT_TYPES.join(", ")}`,
    "",
    "## Assumptions",
    "- assumptions[]: list EVERY value you inferred, defaulted, or are unsure about (guessed retainer, assumed stack, guessed industry, invented goals, etc.). If you were certain about everything, return an empty array. This list is how the human knows what to double-check.",
    "",
    "## Context",
    "- UK agency: en-GB spelling, £ / pence, Europe/London. Keep names and copy British and professional.",
  ].join("\n");
}

/** System prompt for POST /api/projects/intake (transcript → draft). */
export function buildIntakeSystemPrompt(ctx: PromptContext): string {
  return [
    sharedRules(),
    "",
    "## " + "Existing clients",
    clientsBlock(ctx.clients),
    "",
    "The user message is the raw call transcript. Produce the best possible first-pass draft.",
  ].join("\n");
}

export interface RefinePromptContext extends PromptContext {
  draft: ProjectDraft;
  transcript?: string;
}

/** System prompt for POST /api/projects/intake/refine (draft + instruction → draft + note). */
export function buildRefineSystemPrompt(ctx: RefinePromptContext): string {
  const parts = [
    sharedRules(),
    "",
    "## Refinement mode",
    "You are editing an EXISTING draft. Apply the user's instruction (the user message) and return the FULL updated draft plus a one-sentence `note` summarising what you changed. Preserve every field the instruction does not touch. Keep assumptions[] accurate after your edit.",
    "",
    "## " + "Existing clients",
    clientsBlock(ctx.clients),
    "",
    "## Current draft (JSON)",
    "```json",
    JSON.stringify(ctx.draft, null, 2),
    "```",
  ];
  if (ctx.transcript) {
    parts.push(
      "",
      "## Original call transcript (for reference)",
      ctx.transcript,
    );
  }
  return parts.join("\n");
}
