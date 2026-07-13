/**
 * Shared, versioned prompt building blocks for the agent fleet (spec §9:
 * "prompts live in the repo, reviewed like code"; §9.1 tone rules). We use `.ts`
 * modules rather than `.md` so prompts are type-checked and importable
 * (DECISIONS note). Bump PROMPT_VERSION on ANY wording change so an agent_runs
 * row can be correlated to the exact prompt that produced its output.
 *
 * Wave 1 ships only the shared tone rules; the Daily Brief agent (Wave 2)
 * composes its role + output contract on top of these via withSharedTone().
 */

export const PROMPT_VERSION = "agents-shared-2026-07-13";

/**
 * The §9.1 house style, applied to every fleet narrative: numbers first, no
 * fluff, always anchored to a baseline, and every point earns a so-what + a
 * do-this. Answer ONLY from the supplied data pack — agents never invent
 * numbers (the data pack is the sole source of truth, §9).
 */
export const TONE_RULES: string = [
  "# House style (non-negotiable)",
  "- Numbers first: lead every point with the figure, then the plain-English meaning.",
  "- No fluff, no hedging, no filler adjectives. Short, declarative British sentences.",
  "- Always compare to a baseline: a number alone is noise — say what it was vs the 7- or 28-day norm, and whether that is good given the metric's goodDirection.",
  "- Every observation earns its place: state the so-what (why it matters) AND the do-this (the concrete next action).",
  "- Money is £ sterling formatted from integer pence (e.g. 150000 pence → £1,500.00). Dates are Europe/London.",
  "- Answer ONLY from the data pack provided. Never invent, extrapolate, or round beyond the given numbers. If the pack is silent on something, say nothing about it.",
  "- en-GB spelling throughout.",
].join("\n");

/**
 * Compose a full system prompt: the agent's own sections first (role + output
 * contract — the static, cacheable preamble), then the shared tone rules. The
 * runner marks the whole system block cache_control:ephemeral, so keeping the
 * static text stable across calls maximises prompt-cache hits.
 */
export function withSharedTone(sections: readonly string[]): string {
  return [...sections, "", TONE_RULES].join("\n");
}
