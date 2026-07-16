import { describe, expect, it } from "vitest";
import { buildCreatePayload, blankDraft } from "../../lib/onboarding/wizard";
import { projectCreateSchema } from "../../lib/server/schemas";
import type { ProjectDraft } from "../../lib/server/intake/schema";

/**
 * Pins the wizard's single create-call payload (step 4, StepKeys) against the
 * REAL POST /api/projects zod schema — not a hand-copied shape. If the
 * contract ever adds a required field or tightens a bound, this fails loudly
 * instead of the wizard silently 400ing at the one moment it actually writes
 * something.
 */

function draftWith(overrides: Partial<ProjectDraft> = {}): ProjectDraft {
  return { ...blankDraft("ai_agent", "custom_code"), ...overrides };
}

describe("buildCreatePayload vs projectCreateSchema", () => {
  it("parses for a minimal new-client draft", () => {
    const draft = draftWith({
      name: "Booking bot",
      client: { match: "new", clientId: null, name: "Bright Smile Dental", industrySlug: "dental" },
    });
    const parsed = projectCreateSchema.safeParse(buildCreatePayload(draft));
    expect(parsed.success).toBe(true);
  });

  it("parses for a fully-populated existing-client draft", () => {
    const draft = draftWith({
      name: "Reception agent",
      type: "voice_agent",
      stack: "n8n",
      description: "Handles inbound calls and books consultations.",
      retainerPenceMonthly: 150_000,
      buildFeePence: 250_000,
      hourlyRatePence: 8_000,
      goals: [{ metric: "bookings_created", target: 30, period: "week" }],
      client: {
        match: "existing",
        clientId: "22222222-2222-4222-8222-222222222222",
        name: "unused",
        industrySlug: null,
      },
    });
    const parsed = projectCreateSchema.safeParse(buildCreatePayload(draft));
    expect(parsed.success).toBe(true);
  });

  it("never sends both clientId and newClient (schema's exclusive-or refine)", () => {
    const existing = draftWith({
      name: "X",
      client: { match: "existing", clientId: "11111111-1111-4111-8111-111111111111", name: "", industrySlug: null },
    });
    const body = buildCreatePayload(existing);
    expect("clientId" in body).toBe(true);
    expect("newClient" in body).toBe(false);

    const fresh = draftWith({
      name: "X",
      client: { match: "new", clientId: null, name: "New Co", industrySlug: null },
    });
    const body2 = buildCreatePayload(fresh);
    expect("newClient" in body2).toBe(true);
    expect("clientId" in body2).toBe(false);
  });

  it("falls back newClient.name to the project name if the client name is blank", () => {
    const draft = draftWith({
      name: "Fallback Co project",
      client: { match: "new", clientId: null, name: "   ", industrySlug: null },
    });
    const body = buildCreatePayload(draft);
    expect(body.newClient).toEqual({ name: "Fallback Co project" });
    expect(projectCreateSchema.safeParse(body).success).toBe(true);
  });
});
