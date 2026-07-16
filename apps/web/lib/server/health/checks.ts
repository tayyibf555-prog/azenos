/**
 * Pure, deterministic health-check math (docs/phase8/CONTRACTS.md — P8-HEALTH).
 *
 * No I/O: given one project's aggregated spine numbers + a fixed `now`, it
 * derives the per-column grid state, the objective health badge (green/amber/
 * red) and the breach signals that become alert_instances. All SQL lives in
 * evaluate.ts; this file is unit-testable in isolation.
 *
 * Enum-kind reality: the alert_kind enum (migration ≤0009, frozen — no schema
 * edits this phase) has only five values, but the grid runs seven checks. Each
 * check therefore carries a stable `check` discriminator; the evaluator dedupes
 * open instances on (project, check) rather than (project, kind) alone. See
 * docs/DECISIONS.md.
 */

export type HealthColumn =
  | "freshness"
  | "errors"
  | "agent"
  | "slo"
  | "feedback"
  | "retainer";

export type CheckKey =
  | "freshness"
  | "error_streak"
  | "agent_uptime"
  | "error_rate"
  | "p95"
  | "feedback_spike"
  | "retainer_overdue";

/** The five frozen alert_kind enum values (packages/db enums.ts). */
export type AlertKind =
  | "error_streak"
  | "event_silence"
  | "payment_overdue"
  | "anomaly"
  | "custom";

export type AlertSeverity = "info" | "warn" | "critical";

/** Per-column grid cell state. `na` = check not applicable (no SLO / no signal). */
export type CellState = "pass" | "warn" | "critical" | "na";

export type HealthBadge = "green" | "amber" | "red";

export interface ProjectSlo {
  error_rate_pct?: number;
  p95_ms?: number;
  heartbeat_gap_minutes?: number;
}

/** One live project's aggregated spine numbers, all windowed against `now`. */
export interface ProjectHealthInput {
  projectId: string;
  clientId: string;
  slo: ProjectSlo | null;
  /** max(occurred_at) across all events, or null if the project never fired. */
  lastEventAt: Date | null;
  /** system.error count in the last ERROR_STREAK_WINDOW_MIN. */
  errorCountWindow: number;
  /** total events in the last 24h (denominator for error rate). */
  totalEvents24h: number;
  /** system.error count in the last 24h. */
  errorEvents24h: number;
  /** whether the project has EVER emitted agent.heartbeat (all-time existence). */
  hasHeartbeats: boolean;
  /** max(worst internal gap in 24h, gap from the last heartbeat ever to `now`);
   *  null only when the project never had a heartbeat agent. A long-dead agent
   *  reads as a huge gap-to-now → critical, not `na`. */
  maxHeartbeatGapMin: number | null;
  /** p95 of data.duration_ms over 24h; null if no timed samples. */
  p95DurationMs: number | null;
  /** bug / severity≥3 feedback items created in the last 24h. */
  negativeFeedback24h: number;
  /** a past_due retainer subscription covers this project. */
  retainerPastDue: boolean;
}

export interface CheckResult {
  check: CheckKey;
  column: HealthColumn;
  kind: AlertKind;
  state: CellState;
  message: string;
  evidence: Record<string, unknown>;
}

/** A breach worth an alert_instance (state warn | critical). */
export interface HealthSignal {
  check: CheckKey;
  column: HealthColumn;
  kind: AlertKind;
  severity: Exclude<AlertSeverity, "info">;
  message: string;
  evidence: Record<string, unknown>;
}

// ── Platform defaults (per-project SLOs override where set) ──────────────────

export const DEFAULT_HEARTBEAT_GAP_MINUTES = 240;
export const ERROR_STREAK_WINDOW_MIN = 30;
export const ERROR_STREAK_WARN = 3;
export const ERROR_STREAK_CRITICAL = 5;
/** Below this 24h event volume the error-rate ratio is too noisy to judge. */
export const ERROR_RATE_MIN_SAMPLE = 10;
export const FEEDBACK_SPIKE_WARN = 3;
export const FEEDBACK_SPIKE_CRITICAL = 6;
/** A critical instance unacked longer than this escalates (minutes). */
export const ESCALATION_AFTER_MINUTES = 15;

const CHECK_COLUMN: Record<CheckKey, HealthColumn> = {
  freshness: "freshness",
  error_streak: "errors",
  agent_uptime: "agent",
  error_rate: "slo",
  p95: "slo",
  feedback_spike: "feedback",
  retainer_overdue: "retainer",
};

export const COLUMNS: readonly HealthColumn[] = [
  "freshness",
  "errors",
  "agent",
  "slo",
  "feedback",
  "retainer",
];

export const COLUMN_LABEL: Record<HealthColumn, string> = {
  freshness: "Freshness",
  errors: "Errors",
  agent: "Agent uptime",
  slo: "SLO",
  feedback: "Feedback",
  retainer: "Retainer",
};

function minutesBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 60_000;
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * Evaluate all checks for one project. Deterministic in (input, now).
 * Returns one CheckResult per check (including passes / na — the grid needs
 * every cell); breaches are then filtered out by {@link signalsFromResults}.
 */
export function evaluateChecks(
  input: ProjectHealthInput,
  now: Date,
): CheckResult[] {
  const results: CheckResult[] = [];

  // freshness — minutes since last event vs heartbeat_gap SLO (default 240).
  {
    const threshold =
      input.slo?.heartbeat_gap_minutes ?? DEFAULT_HEARTBEAT_GAP_MINUTES;
    let state: CellState;
    let message: string;
    let gapMinutes: number | null;
    if (input.lastEventAt === null) {
      state = "critical";
      gapMinutes = null;
      message = "No events ever received";
    } else {
      const gap = minutesBetween(now, input.lastEventAt);
      gapMinutes = round(gap);
      if (gap <= threshold) state = "pass";
      else if (gap <= threshold * 2) state = "warn";
      else state = "critical";
      message = `Last event ${gapMinutes}m ago (SLO ${threshold}m)`;
    }
    results.push({
      check: "freshness",
      column: CHECK_COLUMN.freshness,
      kind: "event_silence",
      state,
      message,
      evidence: {
        check: "freshness",
        gap_minutes: gapMinutes,
        threshold_minutes: threshold,
        last_event_at: input.lastEventAt?.toISOString() ?? null,
      },
    });
  }

  // error streak — system.error count in the last 30m.
  {
    const count = input.errorCountWindow;
    let state: CellState;
    if (count >= ERROR_STREAK_CRITICAL) state = "critical";
    else if (count >= ERROR_STREAK_WARN) state = "warn";
    else state = "pass";
    results.push({
      check: "error_streak",
      column: CHECK_COLUMN.error_streak,
      kind: "error_streak",
      state,
      message: `${count} error${count === 1 ? "" : "s"} in ${ERROR_STREAK_WINDOW_MIN}m`,
      evidence: {
        check: "error_streak",
        count,
        window_minutes: ERROR_STREAK_WINDOW_MIN,
      },
    });
  }

  // agent uptime — worst heartbeat gap in 24h vs heartbeat_gap SLO.
  {
    const threshold =
      input.slo?.heartbeat_gap_minutes ?? DEFAULT_HEARTBEAT_GAP_MINUTES;
    let state: CellState;
    let message: string;
    if (!input.hasHeartbeats || input.maxHeartbeatGapMin === null) {
      state = "na";
      message = "No heartbeat agents";
    } else {
      const gap = round(input.maxHeartbeatGapMin);
      if (gap <= threshold) state = "pass";
      else if (gap <= threshold * 2) state = "warn";
      else state = "critical";
      message = `Heartbeat gap ${gap}m (SLO ${threshold}m)`;
    }
    results.push({
      check: "agent_uptime",
      column: CHECK_COLUMN.agent_uptime,
      kind: "anomaly",
      state,
      message,
      evidence: {
        check: "agent_uptime",
        max_gap_minutes:
          input.maxHeartbeatGapMin === null
            ? null
            : round(input.maxHeartbeatGapMin),
        threshold_minutes: threshold,
      },
    });
  }

  // error rate — 24h error share vs slo.error_rate_pct (SLO-gated).
  {
    const target = input.slo?.error_rate_pct;
    let state: CellState;
    let message: string;
    let ratePct: number | null = null;
    if (target === undefined) {
      state = "na";
      message = "No error-rate SLO";
    } else if (input.totalEvents24h < ERROR_RATE_MIN_SAMPLE) {
      state = "na";
      message = "Too few events to judge";
    } else {
      const rate = (input.errorEvents24h / input.totalEvents24h) * 100;
      ratePct = Math.round(rate * 10) / 10;
      if (rate > target * 2) state = "critical";
      else if (rate > target) state = "warn";
      else state = "pass";
      message = `Error rate ${ratePct}% (SLO ${target}%)`;
    }
    results.push({
      check: "error_rate",
      column: CHECK_COLUMN.error_rate,
      kind: "anomaly",
      state,
      message,
      evidence: {
        check: "error_rate",
        rate_pct: ratePct,
        threshold_pct: target ?? null,
        total_24h: input.totalEvents24h,
        errors_24h: input.errorEvents24h,
      },
    });
  }

  // p95 duration — 24h p95 of data.duration_ms vs slo.p95_ms (SLO-gated).
  {
    const target = input.slo?.p95_ms;
    let state: CellState;
    let message: string;
    if (target === undefined) {
      state = "na";
      message = "No latency SLO";
    } else if (input.p95DurationMs === null) {
      state = "na";
      message = "No timed samples";
    } else {
      const p95 = round(input.p95DurationMs);
      if (p95 > target * 2) state = "critical";
      else if (p95 > target) state = "warn";
      else state = "pass";
      message = `p95 ${p95}ms (SLO ${target}ms)`;
    }
    results.push({
      check: "p95",
      column: CHECK_COLUMN.p95,
      kind: "custom",
      state,
      message,
      evidence: {
        check: "p95",
        p95_ms: input.p95DurationMs === null ? null : round(input.p95DurationMs),
        threshold_ms: target ?? null,
      },
    });
  }

  // feedback negative-spike — bug / severe feedback in the last 24h.
  {
    const n = input.negativeFeedback24h;
    let state: CellState;
    if (n >= FEEDBACK_SPIKE_CRITICAL) state = "critical";
    else if (n >= FEEDBACK_SPIKE_WARN) state = "warn";
    else state = "pass";
    results.push({
      check: "feedback_spike",
      column: CHECK_COLUMN.feedback_spike,
      kind: "custom",
      state,
      message: `${n} negative report${n === 1 ? "" : "s"} in 24h`,
      evidence: { check: "feedback_spike", negative_24h: n },
    });
  }

  // retainer — a past_due subscription covering this project.
  {
    const state: CellState = input.retainerPastDue ? "warn" : "pass";
    results.push({
      check: "retainer_overdue",
      column: CHECK_COLUMN.retainer_overdue,
      kind: "payment_overdue",
      state,
      message: input.retainerPastDue ? "Retainer past due" : "Retainer current",
      evidence: { check: "retainer_overdue", past_due: input.retainerPastDue },
    });
  }

  return results;
}

const SEVERITY_RANK: Record<CellState, number> = {
  na: 0,
  pass: 1,
  warn: 2,
  critical: 3,
};

/** Worst state per grid column (na only if every check in the column is na). */
export function columnStates(
  results: CheckResult[],
): Record<HealthColumn, CellState> {
  const out = {} as Record<HealthColumn, CellState>;
  for (const col of COLUMNS) out[col] = "na";
  for (const r of results) {
    if (SEVERITY_RANK[r.state] > SEVERITY_RANK[out[r.column]]) {
      out[r.column] = r.state;
    }
  }
  return out;
}

/** Objective health badge: red on any critical, amber on any warn, else green. */
export function deriveHealth(results: CheckResult[]): HealthBadge {
  let worst: CellState = "pass";
  for (const r of results) {
    if (SEVERITY_RANK[r.state] > SEVERITY_RANK[worst]) worst = r.state;
  }
  if (worst === "critical") return "red";
  if (worst === "warn") return "amber";
  return "green";
}

/** Breaches (warn|critical) → alert signals. */
export function signalsFromResults(results: CheckResult[]): HealthSignal[] {
  const out: HealthSignal[] = [];
  for (const r of results) {
    if (r.state === "warn" || r.state === "critical") {
      out.push({
        check: r.check,
        column: r.column,
        kind: r.kind,
        severity: r.state,
        message: r.message,
        evidence: r.evidence,
      });
    }
  }
  return out;
}

/** Convenience: full evaluation of one project in one call. */
export function evaluateProject(
  input: ProjectHealthInput,
  now: Date,
): {
  results: CheckResult[];
  columns: Record<HealthColumn, CellState>;
  health: HealthBadge;
  signals: HealthSignal[];
} {
  const results = evaluateChecks(input, now);
  return {
    results,
    columns: columnStates(results),
    health: deriveHealth(results),
    signals: signalsFromResults(results),
  };
}
