import { describe, expect, it } from "vitest";
import {
  METRIC_CATALOG,
  coreTemplatesForPlanTypes,
  matchGroup,
  type EventTypeSignal,
} from "../../lib/metric-catalog";

/** Pure matchGroup()/coreTemplatesForPlanTypes() cases — no I/O. */

function signal(
  type: string,
  opts: { count?: number; hasValuePence?: boolean; hasMinutesSaved?: boolean } = {},
): EventTypeSignal {
  return {
    type,
    count: opts.count ?? 1,
    hasValuePence: opts.hasValuePence ?? false,
    hasMinutesSaved: opts.hasMinutesSaved ?? false,
  };
}

function group(id: string) {
  const g = METRIC_CATALOG.find((g) => g.id === id);
  if (!g) throw new Error(`no catalog group ${id}`);
  return g;
}

describe("matchGroup", () => {
  it("no signals at all → null", () => {
    expect(matchGroup(group("conversations"), new Map())).toBeNull();
  });

  it("llm.conversation present → matches with a 'seen N×' evidence string", () => {
    const signals = new Map([["llm.conversation", signal("llm.conversation", { count: 42 })]]);
    const result = matchGroup(group("conversations"), signals);
    expect(result).not.toBeNull();
    expect(result!.why).toBe("llm.conversation seen 42×");
  });

  it("payment.* present but value_pence never set → null (requireValuePence unmet)", () => {
    const signals = new Map([
      ["payment.captured", signal("payment.captured", { count: 214, hasValuePence: false })],
    ]);
    expect(matchGroup(group("payment_value"), signals)).toBeNull();
  });

  it("payment.* present WITH value_pence set → matches, evidence names the field", () => {
    const signals = new Map([
      ["payment.captured", signal("payment.captured", { count: 214, hasValuePence: true })],
    ]);
    const result = matchGroup(group("payment_value"), signals);
    expect(result).not.toBeNull();
    expect(result!.why).toBe("payment.captured seen 214× with value_pence set");
  });

  it("funnel_conversion requires BOTH a lead.* type AND a payment.* type", () => {
    const leadOnly = new Map([["lead.created", signal("lead.created", { count: 5 })]]);
    expect(matchGroup(group("funnel_conversion"), leadOnly)).toBeNull();

    const both = new Map([
      ["lead.created", signal("lead.created", { count: 5 })],
      ["payment.captured", signal("payment.captured", { count: 3 })],
    ]);
    const result = matchGroup(group("funnel_conversion"), both);
    expect(result).not.toBeNull();
    expect(result!.why).toBe("lead.created seen 5× · payment.captured seen 3×");
  });

  it("minutes_saved group requires the field on one of its anyOf types", () => {
    const withoutField = new Map([
      ["agent.run.completed", signal("agent.run.completed", { count: 9, hasMinutesSaved: false })],
    ]);
    expect(matchGroup(group("minutes_saved"), withoutField)).toBeNull();

    const withField = new Map([
      ["agent.run.completed", signal("agent.run.completed", { count: 9, hasMinutesSaved: true })],
    ]);
    const result = matchGroup(group("minutes_saved"), withField);
    expect(result?.why).toBe("agent.run.completed seen 9× with minutes_saved set");
  });
});

describe("coreTemplatesForPlanTypes", () => {
  it("returns catalog templates whose group overlaps the plan's event types", () => {
    const core = coreTemplatesForPlanTypes(new Set(["llm.conversation", "booking.created"]));
    const keys = core.map((t) => t.key);
    expect(keys).toContain("conversations");
    expect(keys).toContain("conversation_avg_turns");
    expect(keys).toContain("bookings_created");
    // agent.feedback isn't in this plan → its templates are absent
    expect(keys).not.toContain("agent_feedback_avg_rating");
  });

  it("empty plan → empty core", () => {
    expect(coreTemplatesForPlanTypes(new Set())).toEqual([]);
  });

  it("de-duplicates by key even if a type appears in two groups", () => {
    const core = coreTemplatesForPlanTypes(
      new Set(["lead.created", "payment.captured"]),
    );
    const keys = core.map((t) => t.key);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });
});
