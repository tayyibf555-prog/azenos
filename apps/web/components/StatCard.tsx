import type { ReactNode } from "react";

/** Hero stat card — muted label over a large number, optional sub-line. */
export function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="card" style={{ padding: "16px 18px" }}>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 660,
          marginTop: 6,
          letterSpacing: "-0.02em",
          color: accent ?? "var(--text)",
        }}
      >
        {value}
      </div>
      {sub && (
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
