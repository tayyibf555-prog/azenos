import { BenchmarkBlock } from "../../../components/BenchmarkBlock";
import { Markdown } from "../../../components/Markdown";
import { formatPence } from "../../../lib/format";
import type { ClientBenchmark } from "../../../lib/server/benchmarks";
import type { SharedMonthlyReport } from "../../../lib/server/share";
import { ShareShell } from "./ShareShell";

/** One headline value tile (calm, single hue — royal-soft numbers on glass). */
function ValueTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      className="card"
      style={{
        padding: "16px 18px",
        display: "grid",
        gap: 4,
        alignContent: "start",
      }}
    >
      <span
        style={{
          fontSize: 11.5,
          color: "var(--text-3)",
          letterSpacing: "0.02em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        className="tnum"
        style={{
          fontSize: 26,
          fontWeight: 680,
          letterSpacing: "-0.02em",
          lineHeight: 1.1,
          background:
            "linear-gradient(180deg, var(--text), var(--accent-2))",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        {value}
      </span>
      {sub && (
        <span className="tnum" style={{ fontSize: 12, color: "var(--text-3)" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function roiLabel(roi: number | null): string {
  return roi != null ? `${roi.toFixed(1)}×` : "—";
}

function hoursLabel(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function pctLabel(rate: number | null): string | undefined {
  return rate != null ? `${Math.round(rate * 100)}% resolved` : undefined;
}

export function MonthlyReportDoc({
  report,
  benchmark = null,
}: {
  report: SharedMonthlyReport;
  /** P8-BENCH: the client's industry benchmark, or null to hide the slot. */
  benchmark?: ClientBenchmark | null;
}) {
  const v = report.value;
  return (
    <ShareShell
      agencyName={report.agencyName}
      eyebrow={
        report.monthLabel
          ? `Monthly value report · ${report.monthLabel}`
          : "Monthly value report"
      }
    >
      <section style={{ display: "grid", gap: 6 }}>
        <h1
          style={{
            fontSize: "clamp(22px, 4vw, 30px)",
            fontWeight: 680,
            letterSpacing: "-0.02em",
            lineHeight: 1.15,
          }}
        >
          {report.headline}
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--text-2)" }}>
          Here&apos;s what we delivered for {report.clientName}
          {report.monthLabel ? ` in ${report.monthLabel}` : ""}.
        </p>
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
        }}
      >
        <ValueTile
          label="Value delivered"
          value={formatPence(v.revenueTouchedPence)}
          sub={v.bookingsMade > 0 ? `${v.bookingsMade} bookings` : undefined}
        />
        <ValueTile
          label="Hours saved"
          value={hoursLabel(v.hoursSaved)}
          sub={
            v.conversationsHandled > 0
              ? `${v.conversationsHandled} conversations`
              : undefined
          }
        />
        <ValueTile
          label="Return on investment"
          value={roiLabel(v.roiMultiple)}
          sub={pctLabel(v.resolvedRate)}
        />
      </section>

      {/* Benchmark slot — P8-BENCH. Renders the client's value against the
          anonymised industry median; null benchmark degrades to hidden. */}
      <BenchmarkBlock data={benchmark} variant="report" />


      <section className="card" style={{ padding: "22px 24px" }}>
        <Markdown source={report.bodyMd} />
      </section>
    </ShareShell>
  );
}
