import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEARTBEAT_GAP_MINUTES,
  type ProjectHealthInput,
  evaluateProject,
} from "../../lib/server/health/checks";

const NOW = new Date("2026-07-16T12:00:00.000Z");

function baseInput(over: Partial<ProjectHealthInput> = {}): ProjectHealthInput {
  return {
    projectId: "p1",
    clientId: "c1",
    slo: null,
    lastEventAt: new Date(NOW.getTime() - 5 * 60_000),
    errorCountWindow: 0,
    totalEvents24h: 100,
    errorEvents24h: 0,
    hasHeartbeats: false,
    maxHeartbeatGapMin: null,
    p95DurationMs: null,
    negativeFeedback24h: 0,
    retainerPastDue: false,
    ...over,
  };
}

describe("evaluateProject — pure health math", () => {
  it("a fresh, quiet project is all green", () => {
    const { health, columns, signals } = evaluateProject(baseInput(), NOW);
    expect(health).toBe("green");
    expect(signals).toHaveLength(0);
    expect(columns.freshness).toBe("pass");
    // no SLO / no heartbeats → those columns are na, not failing
    expect(columns.slo).toBe("na");
    expect(columns.agent).toBe("na");
  });

  it("freshness: never-fired project is critical (red)", () => {
    const { health, columns, signals } = evaluateProject(
      baseInput({ lastEventAt: null }),
      NOW,
    );
    expect(columns.freshness).toBe("critical");
    expect(health).toBe("red");
    expect(signals.some((s) => s.check === "freshness")).toBe(true);
  });

  it("freshness: warn between 1x and 2x SLO, critical beyond 2x", () => {
    const threshold = DEFAULT_HEARTBEAT_GAP_MINUTES; // 240
    const warn = evaluateProject(
      baseInput({ lastEventAt: new Date(NOW.getTime() - (threshold + 30) * 60_000) }),
      NOW,
    );
    expect(warn.columns.freshness).toBe("warn");
    expect(warn.health).toBe("amber");

    const crit = evaluateProject(
      baseInput({ lastEventAt: new Date(NOW.getTime() - (threshold * 2 + 30) * 60_000) }),
      NOW,
    );
    expect(crit.columns.freshness).toBe("critical");
    expect(crit.health).toBe("red");
  });

  it("freshness respects a custom heartbeat_gap SLO", () => {
    const { columns } = evaluateProject(
      baseInput({
        slo: { heartbeat_gap_minutes: 10 },
        lastEventAt: new Date(NOW.getTime() - 15 * 60_000),
      }),
      NOW,
    );
    // 15m gap > 10m SLO but ≤ 2x → warn
    expect(columns.freshness).toBe("warn");
  });

  it("error streak: warn at 3, critical at 5", () => {
    expect(evaluateProject(baseInput({ errorCountWindow: 2 }), NOW).columns.errors).toBe("pass");
    expect(evaluateProject(baseInput({ errorCountWindow: 3 }), NOW).columns.errors).toBe("warn");
    expect(evaluateProject(baseInput({ errorCountWindow: 5 }), NOW).columns.errors).toBe("critical");
  });

  it("error rate: SLO-gated, warn over threshold, critical over 2x", () => {
    // no SLO → na regardless of errors
    expect(
      evaluateProject(baseInput({ errorEvents24h: 50, totalEvents24h: 100 }), NOW)
        .columns.slo,
    ).toBe("na");

    // 8% over a 5% SLO → warn
    const warn = evaluateProject(
      baseInput({ slo: { error_rate_pct: 5 }, errorEvents24h: 8, totalEvents24h: 100 }),
      NOW,
    );
    expect(warn.columns.slo).toBe("warn");

    // 12% over a 5% SLO (>2x) → critical
    const crit = evaluateProject(
      baseInput({ slo: { error_rate_pct: 5 }, errorEvents24h: 12, totalEvents24h: 100 }),
      NOW,
    );
    expect(crit.columns.slo).toBe("critical");
  });

  it("error rate: below the sample floor is na, not a false pass", () => {
    const { columns } = evaluateProject(
      baseInput({ slo: { error_rate_pct: 5 }, errorEvents24h: 1, totalEvents24h: 4 }),
      NOW,
    );
    expect(columns.slo).toBe("na");
  });

  it("p95: SLO-gated latency breach", () => {
    const pass = evaluateProject(
      baseInput({ slo: { p95_ms: 2000 }, p95DurationMs: 1500 }),
      NOW,
    );
    expect(pass.columns.slo).toBe("pass");
    const crit = evaluateProject(
      baseInput({ slo: { p95_ms: 2000 }, p95DurationMs: 4500 }),
      NOW,
    );
    expect(crit.columns.slo).toBe("critical");
  });

  it("agent uptime: na without heartbeats, breaches on a wide gap", () => {
    expect(evaluateProject(baseInput(), NOW).columns.agent).toBe("na");
    const crit = evaluateProject(
      baseInput({
        slo: { heartbeat_gap_minutes: 60 },
        hasHeartbeats: true,
        maxHeartbeatGapMin: 200,
      }),
      NOW,
    );
    expect(crit.columns.agent).toBe("critical");
  });

  it("feedback spike: warn at 3, critical at 6 negatives", () => {
    expect(evaluateProject(baseInput({ negativeFeedback24h: 2 }), NOW).columns.feedback).toBe("pass");
    expect(evaluateProject(baseInput({ negativeFeedback24h: 3 }), NOW).columns.feedback).toBe("warn");
    expect(evaluateProject(baseInput({ negativeFeedback24h: 6 }), NOW).columns.feedback).toBe("critical");
  });

  it("retainer: past_due is a warn", () => {
    const { columns, health } = evaluateProject(
      baseInput({ retainerPastDue: true }),
      NOW,
    );
    expect(columns.retainer).toBe("warn");
    expect(health).toBe("amber");
  });

  it("badge takes the worst column across all checks", () => {
    const { health, signals } = evaluateProject(
      baseInput({ errorCountWindow: 5, negativeFeedback24h: 3 }),
      NOW,
    );
    expect(health).toBe("red");
    // both breaches surface as distinct signals
    expect(signals.map((s) => s.check).sort()).toEqual(["error_streak", "feedback_spike"]);
  });
});
