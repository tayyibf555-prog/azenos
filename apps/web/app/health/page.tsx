import Link from "next/link";
import { ChurnChip } from "../../components/ChurnChip";
import { PageHeader } from "../../components/PageHeader";
import { StatCard } from "../../components/StatCard";
import {
  AlertsPanel,
  ReevaluateButton,
} from "../../components/health/HealthActions";
import { Pill, TINTS, type SquircleTone } from "../../components/system";
import {
  type CellState,
  COLUMN_LABEL,
  type HealthBadge,
  type HealthColumn,
} from "../../lib/server/health/checks";
import {
  type HealthGrid,
  getHealthGrid,
  listOpenAlerts,
} from "../../lib/server/health/queries";
import type { OpenAlert } from "../../lib/server/health/queries";
import { getChurnScores, type ChurnScore } from "../../lib/server/churn";
import { requireOrgId } from "../../lib/server/org";

export const dynamic = "force-dynamic";

const STATE_TONE: Record<CellState, SquircleTone> = {
  pass: "mint",
  warn: "butter",
  critical: "rose",
  na: "graphite",
};

const BADGE_TONE: Record<HealthBadge, SquircleTone> = {
  green: "mint",
  amber: "butter",
  red: "rose",
};

/** Traffic-light grid cell — a small tinted-container swatch (RECIPE §4), not
 * a bare dot on white: the wash itself carries the state, the deep-hue dot is
 * just the accent inside it. */
function Cell({
  state,
  messages,
}: {
  state: CellState;
  messages: { state: CellState; message: string }[];
}) {
  const tone = STATE_TONE[state];
  const t = TINTS[tone];
  const title = messages.map((m) => m.message).join(" · ") || (state === "na" ? "Not applicable" : undefined);
  return (
    <td style={{ textAlign: "center" }} title={title}>
      <span
        aria-label={state}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          borderRadius: "var(--radius-icon)",
          background: state === "na" ? "var(--bg-well)" : t.bg,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: state === "na" ? "var(--text-3)" : t.fg,
            opacity: state === "na" ? 0.5 : 1,
          }}
        />
      </span>
    </td>
  );
}

function HealthBadgePill({ health }: { health: HealthBadge }) {
  return (
    <Pill tone={BADGE_TONE[health]}>
      <span style={{ textTransform: "capitalize" }}>{health}</span>
    </Pill>
  );
}

function Grid({
  grid,
  churnByClient,
}: {
  grid: HealthGrid;
  churnByClient: Map<string, ChurnScore>;
}) {
  if (grid.clients.length === 0) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <p className="muted" style={{ fontSize: 13.5 }}>
          No live projects yet. Health lights up once a project goes live and
          starts receiving events.
        </p>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {grid.clients.map((client) => {
        const churn = churnByClient.get(client.clientId);
        return (
        <div key={client.clientId}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 8,
            }}
          >
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--text-2)",
                letterSpacing: "0.01em",
              }}
            >
              {client.clientName}
            </span>
            {churn ? (
              <ChurnChip
                score={churn.score}
                band={churn.band}
                reasons={churn.reasons}
                size="sm"
              />
            ) : null}
          </div>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table className="table" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Project</th>
                  {grid.columns.map((col: HealthColumn) => (
                    <th key={col} style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                      {COLUMN_LABEL[col]}
                    </th>
                  ))}
                  <th style={{ textAlign: "center" }}>Health</th>
                  <th style={{ textAlign: "center" }}>Alerts</th>
                </tr>
              </thead>
              <tbody>
                {client.projects.map((p) => (
                  <tr key={p.projectId}>
                    <td style={{ textAlign: "left" }}>
                      <Link
                        href={`/projects/${p.slug}`}
                        style={{ fontWeight: 550, color: "var(--text)" }}
                      >
                        {p.projectName}
                      </Link>
                    </td>
                    {grid.columns.map((col: HealthColumn) => (
                      <Cell
                        key={col}
                        state={p.columns[col]}
                        messages={p.cells[col]}
                      />
                    ))}
                    <td style={{ textAlign: "center" }}>
                      <HealthBadgePill health={p.health} />
                    </td>
                    <td style={{ textAlign: "center" }} className="tnum">
                      {p.openAlerts > 0 ? (
                        <span style={{ color: "var(--amber)", fontWeight: 600 }}>
                          {p.openAlerts}
                        </span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        );
      })}
    </div>
  );
}

function twilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_FROM,
  );
}

export default async function HealthPage() {
  let dbError: string | null = null;
  let grid: HealthGrid | null = null;
  let alerts: OpenAlert[] = [];
  let churnByClient = new Map<string, ChurnScore>();
  try {
    const orgId = await requireOrgId();
    const [g, a, churn] = await Promise.all([
      getHealthGrid(orgId),
      listOpenAlerts(orgId),
      getChurnScores(orgId),
    ]);
    grid = g;
    alerts = a;
    churnByClient = new Map(churn.map((c) => [c.clientId, c]));
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const criticalUnacked = alerts.filter(
    (a) => a.severity === "critical" && !a.ackedAt,
  ).length;
  const showTwilioBanner = criticalUnacked > 0 && !twilioConfigured();

  return (
    <div>
      <PageHeader
        title="Health"
        subtitle="Objective reliability across every live project — freshness, errors, SLOs, feedback and retainers."
        actions={<ReevaluateButton />}
      />

      {dbError || !grid ? (
        <div className="card" style={{ padding: 20 }}>
          <strong style={{ color: "var(--red)" }}>Database not reachable.</strong>
          <pre className="codeblock" style={{ marginTop: 8 }}>{dbError}</pre>
        </div>
      ) : (
        <>
          {showTwilioBanner && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "11px 16px",
                marginBottom: 18,
                fontSize: 13,
                color: TINTS.butter.fg,
                background: TINTS.butter.bg,
                borderRadius: "var(--radius-tile)",
              }}
            >
              <span
                className="dot"
                style={{ width: 7, height: 7, background: TINTS.butter.fg }}
                aria-hidden
              />
              {criticalUnacked} critical alert{criticalUnacked === 1 ? "" : "s"}{" "}
              unacked — WhatsApp escalation needs TWILIO_ACCOUNT_SID /
              TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM.
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 14,
              marginBottom: 26,
            }}
          >
            <StatCard
              label="Silent projects"
              value={grid.silentProjects}
              accent={grid.silentProjects > 0 ? "var(--red)" : undefined}
              sub="no recent events"
            />
            <StatCard
              label="Healthy"
              value={grid.totals.green}
              accent="var(--green)"
              sub="all checks pass"
            />
            <StatCard
              label="Degraded"
              value={grid.totals.amber}
              accent={grid.totals.amber > 0 ? "var(--amber)" : undefined}
              sub="warn breach"
            />
            <StatCard
              label="Critical"
              value={grid.totals.red}
              accent={grid.totals.red > 0 ? "var(--red)" : undefined}
              sub="needs attention"
            />
            <StatCard
              label="Open alerts"
              value={alerts.length}
              accent={alerts.length > 0 ? "var(--amber)" : undefined}
              sub={criticalUnacked > 0 ? `${criticalUnacked} critical unacked` : "none unacked"}
            />
          </div>

          <Grid grid={grid} churnByClient={churnByClient} />

          <section style={{ marginTop: 30 }}>
            <h2
              style={{
                fontSize: 15,
                fontWeight: 620,
                marginBottom: 12,
                letterSpacing: "-0.01em",
              }}
            >
              Open alerts
            </h2>
            <AlertsPanel alerts={alerts} />
          </section>
        </>
      )}
    </div>
  );
}
