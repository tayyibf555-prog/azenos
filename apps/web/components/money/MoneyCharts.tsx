"use client";

import { ExpandableChart } from "../analytics/ExpandableChart";
import { LineChart, type ChartPoint } from "../charts/LineChart";
import { COLORS } from "../ui";
import type { MonthPoint } from "../money-types";

function toPoints(series: MonthPoint[]): ChartPoint[] {
  return series.map((p) => ({ periodStart: `${p.month}-01`, value: p.pence }));
}

function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
      <span
        aria-hidden
        style={{
          width: 14,
          height: 0,
          borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}`,
        }}
      />
      <span className="faint">{label}</span>
    </span>
  );
}

/**
 * MRR-over-time + cash in/out charts (§Money screen). Reuses the M3 LineChart.
 * Numbers-first (APPLE-THEME.md): the hero KPI tiles above already carry the MRR
 * and cash-in/out numbers, so both trend charts stay collapsed behind a single
 * group expand — no chart renders until the viewer asks for it.
 */
export function MoneyCharts({
  mrrSeries,
  cashInSeries,
  cashOutSeries,
}: {
  mrrSeries: MonthPoint[];
  cashInSeries: MonthPoint[];
  cashOutSeries: MonthPoint[];
}) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <ExpandableChart label="MRR & cash-flow trends">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 16,
            marginTop: 4,
          }}
        >
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h3 style={{ fontSize: 14, fontWeight: 620 }}>MRR over time</h3>
              <LegendDot color={COLORS.royalSoft} label="Monthly recurring" />
            </div>
            <LineChart
              points={toPoints(mrrSeries)}
              color={COLORS.royalSoft}
              unit="pence"
              period="month"
            />
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h3 style={{ fontSize: 14, fontWeight: 620 }}>Cash in / out</h3>
              <span style={{ display: "inline-flex", gap: 12 }}>
                <LegendDot color={COLORS.green} label="In" />
                <LegendDot color={COLORS.red} label="Out" dashed />
              </span>
            </div>
            <LineChart
              points={toPoints(cashInSeries)}
              comparePoints={toPoints(cashOutSeries)}
              color={COLORS.green}
              unit="pence"
              period="month"
            />
          </div>
        </div>
      </ExpandableChart>
    </div>
  );
}
