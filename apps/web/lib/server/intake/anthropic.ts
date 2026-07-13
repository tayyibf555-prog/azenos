import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic client factory. Server-only (the SDK must never reach a client
 * bundle). Tests `vi.mock` THIS module to inject a fake client, so all intake
 * SDK access must funnel through getAnthropic().
 *
 * Lazily constructed module singleton. A missing/empty ANTHROPIC_API_KEY makes
 * `new Anthropic()` throw at construction; we fall back to a placeholder so the
 * failure surfaces uniformly as an AuthenticationError on the API call instead
 * (run.ts maps both to `anthropic_auth`). The real key is still read from env
 * whenever it is present.
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
