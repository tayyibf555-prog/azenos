import { describe, expect, it } from "vitest";
import {
  STEP_LABELS,
  WIZARD_STEPS,
  blankDraft,
  buildCreatePayload,
  canAdvance,
  clientValid,
  deriveLiveCheck,
  detailsValid,
  diffDraft,
  nextStep,
  poundsToPence,
  prevStep,
} from "../../lib/onboarding/wizard";
import type { ProjectDraft } from "../../lib/server/intake/schema";

/**
 * P8-WIZARD — pure step-machine + payload-mapping + live-check derivation
 * tests. No DOM needed (mirrors the useDictation extraction test pattern):
 * every stateful decision the stepper makes is a plain function here.
 */

function draftWith(overrides: Partial<ProjectDraft> = {}): ProjectDraft {
  return { ...blankDraft("ai_agent", "custom_code"), ...overrides };
}

describe("blankDraft", () => {
  it("starts on the new-client path with everything else empty/null", () => {
    const d = blankDraft("chatbot", "n8n");
    expect(d.name).toBe("");
    expect(d.type).toBe("chatbot");
    expect(d.stack).toBe("n8n");
    expect(d.client).toEqual({ match: "new", clientId: null, name: "", industrySlug: null });
    expect(d.retainerPenceMonthly).toBeNull();
    expect(d.goals).toEqual([]);
  });
});

describe("stepper labels + ordering", () => {
  it("has exactly 5 steps, 1..5, each with a label", () => {
    expect(WIZARD_STEPS).toEqual([1, 2, 3, 4, 5]);
    for (const s of WIZARD_STEPS) {
      expect(typeof STEP_LABELS[s]).toBe("string");
      expect(STEP_LABELS[s].length).toBeGreaterThan(0);
    }
  });
});

describe("nextStep / prevStep", () => {
  it("clamps at both ends and advances by one otherwise", () => {
    expect(nextStep(1)).toBe(2);
    expect(nextStep(4)).toBe(5);
    expect(nextStep(5)).toBe(5); // clamped — no step 6
    expect(prevStep(5)).toBe(4);
    expect(prevStep(1)).toBe(1); // clamped — no step 0
  });
});

describe("clientValid / detailsValid", () => {
  it("requires a clientId when matched to an existing client", () => {
    const noId = draftWith({ client: { match: "existing", clientId: null, name: "", industrySlug: null } });
    expect(clientValid(noId)).toBe(false);
    const withId = draftWith({
      client: { match: "existing", clientId: "11111111-1111-4111-8111-111111111111", name: "", industrySlug: null },
    });
    expect(clientValid(withId)).toBe(true);
  });

  it("requires a non-blank name when creating a new client", () => {
    const blank = draftWith({ client: { match: "new", clientId: null, name: "   ", industrySlug: null } });
    expect(clientValid(blank)).toBe(false);
    const named = draftWith({ client: { match: "new", clientId: null, name: "Bright Smile", industrySlug: null } });
    expect(clientValid(named)).toBe(true);
  });

  it("detailsValid also requires a non-blank project name", () => {
    const named = draftWith({
      name: "",
      client: { match: "new", clientId: null, name: "Bright Smile", industrySlug: null },
    });
    expect(detailsValid(named)).toBe(false);
    expect(detailsValid({ ...named, name: "Reception agent" })).toBe(true);
  });
});

describe("canAdvance — the stepper's per-step gate", () => {
  const invalidClientDraft = draftWith({
    client: { match: "new", clientId: null, name: "", industrySlug: null },
  });
  const validDraft = draftWith({
    name: "Reception agent",
    client: { match: "new", clientId: null, name: "Bright Smile", industrySlug: null },
  });

  it("step 1 blocks on an invalid client, unblocks once one is chosen", () => {
    expect(canAdvance(1, invalidClientDraft)).toBe(false);
    expect(canAdvance(1, validDraft)).toBe(true);
  });

  it("step 2 (intake) is always advanceable — it's optional/skippable", () => {
    expect(canAdvance(2, invalidClientDraft)).toBe(true);
    expect(canAdvance(2, validDraft)).toBe(true);
  });

  it("step 3 requires full details (name + client)", () => {
    expect(canAdvance(3, invalidClientDraft)).toBe(false);
    expect(canAdvance(3, validDraft)).toBe(true);
  });

  it("steps 4 and 5 are not gated by client-side draft validation", () => {
    expect(canAdvance(4, invalidClientDraft)).toBe(true);
    expect(canAdvance(5, invalidClientDraft)).toBe(true);
  });
});

describe("diffDraft", () => {
  it("reports only the top-level keys that actually changed", () => {
    const a = draftWith({ name: "Old", retainerPenceMonthly: 1000 });
    const b = { ...a, name: "New" };
    expect(diffDraft(a, b)).toEqual(["name"]);
  });

  it("reports nothing for two structurally-identical drafts", () => {
    const a = draftWith({ goals: [{ metric: "bookings_created", target: 10, period: "week" }] });
    const b = draftWith({ goals: [{ metric: "bookings_created", target: 10, period: "week" }] });
    expect(diffDraft(a, b)).toEqual([]);
  });
});

describe("poundsToPence", () => {
  it("converts a valid £ string to integer pence", () => {
    expect(poundsToPence("15.50")).toBe(1550);
    expect(poundsToPence("1500")).toBe(150000);
  });

  it("returns null for blank, zero, negative, or unparseable input", () => {
    expect(poundsToPence("")).toBeNull();
    expect(poundsToPence("0")).toBeNull();
    expect(poundsToPence("-5")).toBeNull();
    expect(poundsToPence("abc")).toBeNull();
  });
});

describe("buildCreatePayload — the wizard's single create-call mapping", () => {
  it("maps an existing-client draft to clientId, omitting newClient", () => {
    const draft = draftWith({
      name: "Reception agent",
      type: "voice_agent",
      stack: "n8n",
      description: "  Handles inbound calls.  ",
      retainerPenceMonthly: 150000,
      buildFeePence: 250000,
      hourlyRatePence: 8000,
      goals: [{ metric: "bookings_created", target: 30, period: "week" }],
      client: {
        match: "existing",
        clientId: "22222222-2222-4222-8222-222222222222",
        name: "unused",
        industrySlug: null,
      },
    });
    const body = buildCreatePayload(draft);
    expect(body).toEqual({
      name: "Reception agent",
      type: "voice_agent",
      stack: "n8n",
      description: "Handles inbound calls.",
      retainerPenceMonthly: 150000,
      buildFeePence: 250000,
      hourlyRatePence: 8000,
      goals: [{ metric: "bookings_created", target: 30, period: "week" }],
      clientId: "22222222-2222-4222-8222-222222222222",
    });
    expect(body).not.toHaveProperty("newClient");
  });

  it("maps a new-client draft to newClient, omitting clientId", () => {
    const draft = draftWith({
      name: "Booking bot",
      client: { match: "new", clientId: null, name: "Bright Smile Dental", industrySlug: "dental" },
    });
    const body = buildCreatePayload(draft);
    expect(body).toMatchObject({
      newClient: { name: "Bright Smile Dental", industrySlug: "dental" },
    });
    expect(body).not.toHaveProperty("clientId");
  });

  it("omits optional money/description/goals fields when null/blank/empty", () => {
    const draft = draftWith({
      name: "Bare bones",
      client: { match: "new", clientId: null, name: "New Co", industrySlug: null },
    });
    const body = buildCreatePayload(draft);
    expect(body).toEqual({
      name: "Bare bones",
      type: "ai_agent",
      stack: "custom_code",
      newClient: { name: "New Co" },
    });
  });

  it("caps hourlyRatePence at 100,000 and drops non-positive rates", () => {
    const over = buildCreatePayload(
      draftWith({
        name: "X",
        hourlyRatePence: 500_000,
        client: { match: "new", clientId: null, name: "Y", industrySlug: null },
      }),
    );
    expect(over.hourlyRatePence).toBe(100_000);

    const zero = buildCreatePayload(
      draftWith({
        name: "X",
        hourlyRatePence: 0,
        client: { match: "new", clientId: null, name: "Y", industrySlug: null },
      }),
    );
    expect(zero).not.toHaveProperty("hourlyRatePence");
  });
});

describe("deriveLiveCheck", () => {
  it("reports not-received for an empty events page", () => {
    expect(deriveLiveCheck([])).toEqual({ received: false, eventType: null });
  });

  it("reports the type of the first event once one arrives", () => {
    expect(deriveLiveCheck([{ type: "booking.created" }])).toEqual({
      received: true,
      eventType: "booking.created",
    });
  });
});
