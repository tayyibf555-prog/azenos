import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@azen/events";
import {
  TRACKING_PRESETS,
  getTrackingPlan,
  type ProjectTypeKey,
} from "../../lib/tracking-presets";

/**
 * Pins the tracking-plan presets to reality forever: every event type named
 * in ANY preset must be a real key of the @azen/events taxonomy. If the
 * taxonomy ever renames/removes a type, this test fails loudly instead of the
 * Setup tab silently showing a permanently-missing "required" chip.
 */

const KNOWN = new Set<string>(EVENT_TYPES);

describe("TRACKING_PRESETS", () => {
  const projectTypes = Object.keys(TRACKING_PRESETS) as ProjectTypeKey[];

  it("covers exactly the 7 project types", () => {
    expect(projectTypes.sort()).toEqual(
      [
        "ai_agent",
        "automation",
        "chatbot",
        "crm_setup",
        "custom",
        "voice_agent",
        "website",
      ].sort(),
    );
  });

  it.each(projectTypes)(
    "every required/recommended type for %s exists in the real taxonomy",
    (key) => {
      const preset = TRACKING_PRESETS[key];
      for (const type of preset.required) {
        expect(KNOWN.has(type), `${key}.required: unknown type "${type}"`).toBe(
          true,
        );
      }
      for (const type of preset.recommended) {
        expect(
          KNOWN.has(type),
          `${key}.recommended: unknown type "${type}"`,
        ).toBe(true);
      }
    },
  );

  it("never lists the same type as both required and recommended", () => {
    for (const key of projectTypes) {
      const preset = TRACKING_PRESETS[key];
      const requiredSet = new Set(preset.required);
      for (const type of preset.recommended) {
        expect(requiredSet.has(type)).toBe(false);
      }
    }
  });

  it("custom has no required types (bespoke builds aren't second-guessed)", () => {
    expect(TRACKING_PRESETS.custom.required).toEqual([]);
  });

  it("custom's recommended set is the universal core", () => {
    expect(new Set(TRACKING_PRESETS.custom.recommended)).toEqual(
      new Set(["system.error", "agent.heartbeat", "feedback.submitted"]),
    );
  });
});

describe("getTrackingPlan", () => {
  it("returns the matching preset for a known project type", () => {
    expect(getTrackingPlan("chatbot")).toBe(TRACKING_PRESETS.chatbot);
  });

  it("falls back to custom for an unrecognised type", () => {
    expect(getTrackingPlan("not_a_real_type")).toBe(TRACKING_PRESETS.custom);
  });
});
