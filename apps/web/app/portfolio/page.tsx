import Link from "next/link";
import { PageHeader } from "../../components/PageHeader";
import { StatGrid } from "../../components/analytics/StatGrid";
import { StatTile } from "../../components/analytics/StatTile";
import { ExpandableChart } from "../../components/analytics/ExpandableChart";
import { PortfolioQuadrant, type QuadrantPoint } from "../../components/portfolio/PortfolioQuadrant";
import { COLORS, tint } from "../../components/ui";
import { formatPence } from "../../lib/format";
import { getPortfolio, type PortfolioResult } from "../../lib/server/portfolio";
import { requireOrgId } from "../../lib/server/org";

export const dynamic = "force-dynamic";

const HEALTH_LABEL: Record<string, { label: string; color: string }> = {
  green: { label: "On track", color: COLORS.green },
  amber: { label: "Watch", color: COLORS.amber },
  red: { label: "At risk", color: COLORS.red },
};

/**
 * Portfolio (P9-PACK3 — docs/phase9/CONTRACTS.md): a read-only, org-wide
 * rollup of every LIVE project's cost-vs-value this month. Numbers-first:
 * the concentration hero + headline tiles + ranked ROI table carry the
 * story; the value-vs-cost quadrant is the same data as a picture, behind
 * an expand.
 */
export default async function PortfolioPage() {
  let error: string | null = null;
  let data: PortfolioResult = {
    month: "",
    rows: [],
    totals: { costPence: 0, valuePence: 0 },
    concentration: {
      topClientId: null,
      topClientName: null,
      topClientValuePence: 0,
      totalValuePence: 0,
      pct: 0,
    },
  };

  try {
    const orgId = await requireOrgId();
    data = await getPortfolio(orgId);
  } catch (err) {
    console.error("[portfolio] load failed:", err);
    error = "Could not load the portfolio.";
  }

  const orgRoi = data.totals.costPence > 0 ? data.totals.valuePence / data.totals.costPence : null;
  const quadrantPoints: QuadrantPoint[] = data.rows.map((r) => ({
    projectId: r.projectId,
    projectName: r.projectName,
    clientName: r.clientName,
    costPence: r.costPence,
    valuePence: r.valuePence,
    eventsMtd: r.eventsMtd,
    health: r.health,
  }));

  return (
    <div>
      <PageHeader
        title="Portfolio"
        subtitle={`Every live project's cost and value this month${data.month ? ` · ${data.month}` : ""} — one view of where the agency's effort is paying off.`}
      />

      {error && (
        <div className="card" style={{ padding: 16, marginBottom: 20, color: "var(--red)" }}>
          {error}
        </div>
      )}

      {data.rows.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: "center" }}>
          <span className="faint" style={{ fontSize: 13 }}>
            No live projects yet — the portfolio fills in once a project goes live and starts
            recording cost or value.
          </span>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 20 }}>
          {/* concentration hero */}
          <div className="card" style={{ padding: 20, display: "grid", gap: 8 }}>
            <span className="muted" style={{ fontSize: 12.5, fontWeight: 550 }}>
              Revenue concentration this month
            </span>
            {data.concentration.topClientId ? (
              <>
                <span
                  className="tnum"
                  style={{ fontSize: 30, fontWeight: 680, letterSpacing: "-0.02em" }}
                >
                  {data.concentration.pct.toLocaleString("en-GB")}%
                </span>
                <span className="faint" style={{ fontSize: 12.5 }}>
                  of {formatPence(data.concentration.totalValuePence)} attributed value this month
                  comes from <strong style={{ fontWeight: 620 }}>{data.concentration.topClientName}</strong>
                  {" · "}
                  {formatPence(data.concentration.topClientValuePence)}
                </span>
              </>
            ) : (
              <span className="faint" style={{ fontSize: 12.5 }}>
                No attributed value has landed this month yet.
              </span>
            )}
          </div>

          {/* headline numbers */}
          <StatGrid minTileWidth={170}>
            <StatTile
              label="Live projects"
              value={data.rows.length.toLocaleString("en-GB")}
            />
            <StatTile
              label="Cost MTD (OS + emitted)"
              value={formatPence(data.totals.costPence)}
            />
            <StatTile
              label="Value MTD (attributed)"
              value={formatPence(data.totals.valuePence)}
            />
            <StatTile
              label="Portfolio ROI"
              value={orgRoi !== null ? `${orgRoi.toLocaleString("en-GB", { maximumFractionDigits: 2 })}×` : "—"}
              sub={
                orgRoi !== null
                  ? `${formatPence(data.totals.valuePence)} ÷ ${formatPence(data.totals.costPence)}`
                  : "No cost recorded yet"
              }
            />
          </StatGrid>

          {/* ranked ROI table */}
          <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 620 }}>Ranked by ROI</span>
              <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                value ÷ cost, this month — highest first
              </span>
            </div>
            <div style={{ overflowX: "auto", maxWidth: "100%" }}>
              <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr>
                    {["Project", "Client", "Health", "Cost MTD", "Value MTD", "ROI"].map((h, i) => (
                      <th
                        key={h}
                        className="faint"
                        style={{
                          textAlign: i >= 3 ? "right" : "left",
                          fontWeight: 550,
                          fontSize: 11,
                          padding: "0 10px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    const health = HEALTH_LABEL[row.health] ?? HEALTH_LABEL.green!;
                    return (
                      <tr key={row.projectId} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>
                          <Link href={`/projects/${row.projectId}`} style={{ color: "var(--text)" }}>
                            {row.projectName}
                          </Link>
                        </td>
                        <td className="muted" style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>
                          {row.clientName}
                        </td>
                        <td style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>
                          <span
                            className="badge"
                            style={{
                              color: health.color,
                              background: tint(health.color, 0.12),
                              borderColor: tint(health.color, 0.28),
                              fontSize: 11,
                            }}
                          >
                            {health.label}
                          </span>
                        </td>
                        <td className="tnum" style={{ padding: "9px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
                          {formatPence(row.costPence)}
                        </td>
                        <td className="tnum" style={{ padding: "9px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
                          {formatPence(row.valuePence)}
                        </td>
                        <td className="tnum" style={{ padding: "9px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
                          {row.roiMultiple !== null ? `${row.roiMultiple.toLocaleString("en-GB")}×` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <ExpandableChart label="value-vs-cost quadrant">
              <PortfolioQuadrant points={quadrantPoints} />
            </ExpandableChart>
          </div>
        </div>
      )}
    </div>
  );
}
