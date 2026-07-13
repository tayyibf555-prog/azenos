import Link from "next/link";
import { formatPence } from "../lib/format";
import { COLORS, humanize, tint } from "./ui";

export interface TodayCall {
  id: string;
  kind: string;
  startsAt: string;
  inviteeName: string | null;
  status: string;
}

export interface OverduePayment {
  id: string;
  clientName: string;
  amountPence: number;
  kind: string;
}

export interface TodayInsight {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  kind: string;
  confidence: string;
}

export interface TodayData {
  calls: TodayCall[];
  overduePayments: OverduePayment[];
  newInsights: TodayInsight[];
}

const londonHM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function hm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : londonHM.format(d);
}

const CALL_COLOR: Record<string, string> = {
  discovery: COLORS.blue,
  kickoff: COLORS.violet,
  review: COLORS.teal,
};

function Block({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 2px 8px",
        }}
      >
        <h4 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-3)" }}>
          {title}
        </h4>
        {typeof count === "number" && count > 0 && (
          <span className="chip">{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="muted"
      style={{
        fontSize: 12.5,
        padding: "10px 12px",
        border: "1px dashed var(--border)",
        borderRadius: "var(--radius-sm)",
      }}
    >
      {children}
    </p>
  );
}

/**
 * The §5.1 "Today" column on the Command Center: agency calls starting today,
 * overdue expected payments (empty pre-Phase-4), and new insights awaiting
 * review. Pure/server-safe — data is fetched in the page and passed as props.
 */
export function TodayColumn({ data }: { data: TodayData }) {
  return (
    <section className="card" style={{ padding: 18, display: "grid", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <h3 style={{ fontSize: 14 }}>Today</h3>
        <span className="faint" style={{ fontSize: 12 }}>
          what needs you
        </span>
      </div>

      <Block title="Agency calls" count={data.calls.length}>
        {data.calls.length === 0 ? (
          <Quiet>No discovery, kickoff or review calls scheduled today.</Quiet>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {data.calls.map((c) => {
              const color = CALL_COLOR[c.kind] ?? COLORS.grey;
              return (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "8px 11px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--card-2)",
                    fontSize: 13,
                  }}
                >
                  <span className="mono" style={{ color: "var(--text-2)", flex: "none" }}>
                    {hm(c.startsAt)}
                  </span>
                  <span
                    className="badge"
                    style={{
                      flex: "none",
                      color,
                      background: tint(color, 0.12),
                      borderColor: tint(color, 0.28),
                    }}
                  >
                    {humanize(c.kind)}
                  </span>
                  <span className="truncate" style={{ flex: 1, color: "var(--text)" }}>
                    {c.inviteeName ?? "—"}
                  </span>
                  {c.status !== "scheduled" && (
                    <span className="faint" style={{ flex: "none", fontSize: 11.5 }}>
                      {humanize(c.status)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Block>

      <Block title="Overdue payments" count={data.overduePayments.length}>
        {data.overduePayments.length === 0 ? (
          <Quiet>Nothing overdue. Expected-payment tracking arrives in Phase 4.</Quiet>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {data.overduePayments.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  padding: "8px 11px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--card-2)",
                  fontSize: 13,
                }}
              >
                <span className="truncate" style={{ flex: 1, color: "var(--text)" }}>
                  {p.clientName}
                </span>
                <span className="faint" style={{ flex: "none", fontSize: 11.5 }}>
                  {humanize(p.kind)}
                </span>
                <span style={{ flex: "none", color: COLORS.amber, fontWeight: 550 }}>
                  {formatPence(p.amountPence)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Block>

      <Block title="New insights" count={data.newInsights.length}>
        {data.newInsights.length === 0 ? (
          <Quiet>No insights awaiting review.</Quiet>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {data.newInsights.map((ins) => {
              const tone =
                ins.confidence === "high"
                  ? COLORS.red
                  : ins.confidence === "med"
                    ? COLORS.amber
                    : COLORS.grey;
              return (
                <Link
                  key={ins.id}
                  href={`/projects/${ins.projectId}`}
                  className="hoverable"
                  style={{
                    display: "grid",
                    gap: 3,
                    padding: "9px 11px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--card-2)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    <span
                      className="truncate"
                      style={{ fontSize: 13, fontWeight: 550, color: "var(--text)" }}
                    >
                      {ins.title}
                    </span>
                    <span
                      className="badge"
                      style={{
                        flex: "none",
                        color: tone,
                        background: tint(tone, 0.12),
                        borderColor: tint(tone, 0.28),
                      }}
                    >
                      {ins.confidence}
                    </span>
                  </div>
                  <span className="faint" style={{ fontSize: 11.5 }}>
                    {humanize(ins.kind)} · {ins.projectName}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </Block>
    </section>
  );
}
