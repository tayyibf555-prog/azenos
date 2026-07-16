import type { ReactNode } from "react";

/**
 * §1/§4 stat pattern — the ONLY way stats render. A compact KPI strip of
 * dividered cells: quiet 12px label over an 18–20px tnum value (hero variant
 * 24px max) plus an optional delta chip. 4–6 across on desktop, wrapping to a
 * responsive grid. Pure/SSR-safe. See .sys-statrow in globals.css.
 */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className="sys-statrow">{children}</div>;
}

export function StatCell({
  label,
  value,
  delta,
  hero = false,
}: {
  label: string;
  value: ReactNode;
  delta?: { text: string; up?: boolean } | null;
  hero?: boolean;
}) {
  return (
    <div className="sys-statcell">
      <span className="sys-statcell__label">{label}</span>
      <div className="sys-statcell__row">
        <span
          className={
            hero
              ? "sys-statcell__value sys-statcell__value--hero tnum accent-num"
              : "sys-statcell__value tnum"
          }
        >
          {value}
        </span>
        {delta ? (
          <span
            className="sys-statcell__delta"
            style={{ color: delta.up ? "var(--green)" : "var(--red)" }}
          >
            {delta.up ? "▲" : "▼"} {delta.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
