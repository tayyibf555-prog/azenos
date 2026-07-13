import { describe, expect, it } from "vitest";
import {
  coerceClientMatch,
  finalizeDraft,
  GOAL_METRICS,
  projectDraftSchema,
  refineOutputSchema,
} from "../../lib/server/intake/schema";
import { makeDraft } from "./helpers";

describe("projectDraftSchema", () => {
  it("round-trips a valid draft", () => {
    const draft = makeDraft();
    const parsed = projectDraftSchema.parse(draft);
    expect(parsed).toEqual(draft);
  });

  it("rejects an out-of-enum project type", () => {
    const bad = { ...makeDraft(), type: "teleporter" };
    expect(projectDraftSchema.safeParse(bad).success).toBe(false);
  });

  it("wraps draft + note for refine", () => {
    const out = refineOutputSchema.parse({ draft: makeDraft(), note: "Set retainer to £2,000." });
    expect(out.note).toContain("retainer");
    expect(out.draft.name).toBe("Reception voice agent");
  });
});

describe("coerceClientMatch", () => {
  const known = [{ id: "11111111-1111-1111-1111-111111111111" }];

  it("keeps a real existing match", () => {
    const draft = makeDraft({
      client: { match: "existing", clientId: known[0]!.id, name: "X", industrySlug: null },
    });
    expect(coerceClientMatch(draft, known).client).toEqual(draft.client);
  });

  it("demotes an unknown existing clientId to new", () => {
    const draft = makeDraft({
      client: { match: "existing", clientId: "deadbeef", name: "X", industrySlug: null },
    });
    const out = coerceClientMatch(draft, known);
    expect(out.client.match).toBe("new");
    expect(out.client.clientId).toBeNull();
  });

  it("nulls a stray clientId on a new match", () => {
    const draft = makeDraft({
      client: { match: "new", clientId: "deadbeef", name: "X", industrySlug: null },
    });
    expect(coerceClientMatch(draft, known).client.clientId).toBeNull();
  });
});

describe("finalizeDraft", () => {
  it("caps name, goals and dedups event types, then coerces the client", () => {
    const draft = makeDraft({
      name: "x".repeat(400),
      goals: Array.from({ length: 8 }, () => ({
        metric: "bookings_created",
        target: 1,
        period: "week" as const,
      })),
      suggestedEventTypes: ["call.completed", "call.completed", "booking.created"],
      client: { match: "existing", clientId: "not-real", name: "X", industrySlug: null },
    });
    const out = finalizeDraft(draft, []);
    expect(out.name).toHaveLength(200);
    expect(out.goals).toHaveLength(5);
    expect(out.suggestedEventTypes).toEqual(["call.completed", "booking.created"]);
    expect(out.client.match).toBe("new");
    expect(out.client.clientId).toBeNull();
  });
});

describe("GOAL_METRICS", () => {
  it("exposes the §8.1 keys the prompt guides toward", () => {
    const keys = GOAL_METRICS.map((m) => m.key);
    expect(keys).toContain("bookings_created");
    expect(keys).toContain("revenue_attributed");
    expect(keys.length).toBeGreaterThan(10);
  });
});
