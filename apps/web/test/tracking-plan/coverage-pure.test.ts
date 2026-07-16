import { describe, expect, it } from "vitest";
import { coveragePlan, type TrackingPreset } from "../../lib/tracking-presets";

/** Pure coveragePlan() cases: full, partial, and zero coverage. No I/O. */

const plan: TrackingPreset = {
  required: ["lead.created", "lead.stage_changed", "form.submitted"],
  recommended: ["lead.qualified", "email.sent"],
};

describe("coveragePlan", () => {
  it("full coverage: every required + recommended type present", () => {
    const present = new Set([
      "lead.created",
      "lead.stage_changed",
      "form.submitted",
      "lead.qualified",
      "email.sent",
    ]);
    const result = coveragePlan(plan, present);
    expect(result.requiredTotal).toBe(3);
    expect(result.requiredPresent).toBe(3);
    expect(result.items.every((i) => i.present)).toBe(true);
    // required items come first, in preset order
    expect(result.items.slice(0, 3).map((i) => i.type)).toEqual(plan.required);
    expect(result.items.every((i, idx) => i.required === (idx < 3))).toBe(
      true,
    );
  });

  it("partial coverage: some required present, some missing, recommended mixed", () => {
    const present = new Set(["lead.created", "email.sent"]);
    const result = coveragePlan(plan, present);
    expect(result.requiredTotal).toBe(3);
    expect(result.requiredPresent).toBe(1);
    const byType = new Map(result.items.map((i) => [i.type, i]));
    expect(byType.get("lead.created")).toEqual({
      type: "lead.created",
      required: true,
      present: true,
    });
    expect(byType.get("lead.stage_changed")).toEqual({
      type: "lead.stage_changed",
      required: true,
      present: false,
    });
    expect(byType.get("form.submitted")?.present).toBe(false);
    expect(byType.get("lead.qualified")).toEqual({
      type: "lead.qualified",
      required: false,
      present: false,
    });
    expect(byType.get("email.sent")?.present).toBe(true);
  });

  it("zero coverage: no events at all", () => {
    const result = coveragePlan(plan, []);
    expect(result.requiredTotal).toBe(3);
    expect(result.requiredPresent).toBe(0);
    expect(result.items.every((i) => !i.present)).toBe(true);
    expect(result.items).toHaveLength(5);
  });

  it("accepts a plain array of present types as well as a Set", () => {
    const result = coveragePlan(plan, ["lead.created"]);
    expect(result.requiredPresent).toBe(1);
  });

  it("de-duplicates a type listed in both required and recommended input", () => {
    const dupPlan: TrackingPreset = {
      required: ["system.error"],
      recommended: ["system.error", "agent.heartbeat"],
    };
    const result = coveragePlan(dupPlan, []);
    expect(result.items.map((i) => i.type)).toEqual([
      "system.error",
      "agent.heartbeat",
    ]);
    expect(result.items[0]?.required).toBe(true);
  });

  it("empty plan (custom project type with zero required) never crashes", () => {
    const emptyPlan: TrackingPreset = { required: [], recommended: [] };
    const result = coveragePlan(emptyPlan, ["anything"]);
    expect(result.requiredTotal).toBe(0);
    expect(result.requiredPresent).toBe(0);
    expect(result.items).toEqual([]);
  });
});
