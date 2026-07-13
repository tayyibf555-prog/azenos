import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic client factory for the agent fleet. Server-only (the SDK must never
 * reach a client bundle). Tests `vi.mock` THIS module to inject a fake client,
 * so ALL fleet SDK access must funnel through getAnthropic() — mirrors
 * apps/web/lib/server/intake/anthropic.ts, the gate-approved seam.
 *
 * Lazily constructed module singleton. A missing/empty ANTHROPIC_API_KEY makes
 * `new Anthropic()` throw at construction; we fall back to a placeholder so the
 * failure surfaces uniformly as an AuthenticationError on the API call instead
 * (runner.ts maps both to `anthropic_auth`). Graceful degradation, spec §13:
 * the fleet must import and run without any API key present.
 */
let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "missing-anthropic-api-key",
    });
  }
  return client;
}
