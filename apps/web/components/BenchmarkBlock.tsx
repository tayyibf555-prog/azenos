import type {
  BenchmarkBar,
  BenchmarkStanding,
  BenchmarkUnit,
  ClientBenchmark,
} from "../lib/server/benchmarks";
import { formatPence } from "../lib/format";
import { COLORS, tint } from "./ui";

/**
 * Phase 8 §P8-BENCH — the benchmark surface. Fills the shared monthly report's
 * benchmark slot (`variant="report"`) and rides on the Client 360 as a compact
 * strip (`variant="strip"`). PURE and serializable-in: it renders ONLY the
 * subject client's own values against AGGREGATE peer percentiles (p25→p75 band +
 * median). No org id, no client id, no other client's number ever appears.
 *
 * Graceful degradation is the whole contract of the slot: `data === null`
 * (no industry / below the anonymity floor / no signal) renders NOTHING, so the
 * report and Client 360 simply don't show the block. RECIPE §2: borderless
 * --bg-well track (contrast, not a hairline), royal-soft accent for the
 * client's marker + green only for "ahead".
 */

function formatValue(value: number, unit: BenchmarkUnit): string {
  if (unit === "pence") return formatPence(value);
  if (unit === "hours") {
    const rounded = Math.round(value * 10) / 10;
    const label = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${label}h`;
  }
  return Math.round(value).toLocaleString("en-GB");
}

const STANDING_LABEL: Record<BenchmarkStanding, string> = {
  ahead: "Ahead of median",
  near: "Around median",
  behind: "Below median",
};

function standingColor(standing: BenchmarkStanding): string {
  // Two accent hues only: green for a genuine lead, quiet grays otherwise.
  if (standing === "ahead") return "var(--green)";
  return "var(--text-3)";
}

/** % position of `value` along a 0..max track (clamped 0-100). */
function pct(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

function BarRow({ bar }: { bar: BenchmarkBar }) {
  // Track headroom so the client's marker and the p75 whisker never clip.
  const max = Math.max(bar.p75, bar.clientValue, bar.p50, 1) * 1.15;
  const bandLeft = pct(bar.p25, max);
  const bandRight = pct(bar.p75, max);
  const medianAt = pct(bar.p50, max);
  const clientAt = pct(bar.clientValue, max);
  const color = standingColor(bar.standing);

  return (
    <div style={{ display: "grid", gap: 7 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>{bar.label}</span>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
          <span
            className="tnum"
            style={{ fontSize: 15, fontWeight: 640, letterSpacing: "-0.01em" }}
          >
            {formatValue(bar.clientValue, bar.unit)}
          </span>
          <span className="tnum" style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            med {formatValue(bar.p50, bar.unit)}
          </span>
        </span>
      </div>

      {/* Track: peer p25→p75 band, median tick, the client's marker.
          RECIPE T1: separation is contrast, not a hairline — the track sits
          on the deeper --bg-well fill so no border is needed. */}
      <div
        style={{
          position: "relative",
          height: 10,
          borderRadius: 999,
          background: "var(--bg-well)",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${bandLeft}%`,
            width: `${Math.max(bandRight - bandLeft, 0.5)}%`,
            borderRadius: 999,
            background: tint(COLORS.teal, 0.18),
          }}
        />
        <div
          style={{
            position: "absolute",
            top: -2,
            bottom: -2,
            left: `${medianAt}%`,
            width: 2,
            transform: "translateX(-1px)",
            borderRadius: 2,
            background: "var(--text-3)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: `${clientAt}%`,
            width: 12,
            height: 12,
            transform: "translate(-50%, -50%)",
            borderRadius: 999,
            background: "var(--accent-2)",
            border: "2px solid var(--bg)",
            boxShadow: "0 0 0 1px var(--accent)",
          }}
        />
      </div>

      <span style={{ fontSize: 11, color, fontWeight: 550 }}>
        {STANDING_LABEL[bar.standing]}
      </span>
    </div>
  );
}

export function BenchmarkBlock({
  data,
  variant = "report",
}: {
  data: ClientBenchmark | null;
  variant?: "report" | "strip";
}) {
  // Degrade to hidden — the slot renders nothing below the floor / with no data.
  if (!data || data.bars.length === 0) return null;

  const peers = data.sampleClients - 1;
  const caption =
    peers > 0
      ? `vs ${peers} other ${data.industryName} ${peers === 1 ? "client" : "clients"} · ${data.monthLabel}`
      : `${data.industryName} · ${data.monthLabel}`;

  return (
    <section
      className="card"
      style={{
        padding: variant === "strip" ? "18px 20px" : "22px 24px",
        display: "grid",
        gap: 16,
      }}
    >
      <div style={{ display: "grid", gap: 3 }}>
        <span
          style={{
            fontSize: 11.5,
            color: "var(--text-3)",
            letterSpacing: "0.02em",
            textTransform: "uppercase",
          }}
        >
          How this compares
        </span>
        <span style={{ fontSize: 13, color: "var(--text-2)" }}>{caption}</span>
      </div>

      <div
        style={{
          display: "grid",
          gap: variant === "strip" ? 16 : 18,
          gridTemplateColumns:
            variant === "strip"
              ? "repeat(auto-fit, minmax(230px, 1fr))"
              : "1fr",
        }}
      >
        {data.bars.map((bar) => (
          <BarRow key={bar.key} bar={bar} />
        ))}
      </div>
    </section>
  );
}
