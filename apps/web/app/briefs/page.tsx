import { desc, eq } from "drizzle-orm";
import { briefs, clients, db, projects } from "@azen/db";
import { ActivationBanner } from "../../components/ActivationBanner";
import { BriefsBrowser, type BriefRow } from "../../components/BriefsBrowser";
import { GenerateBriefButton } from "../../components/GenerateBriefButton";
import { PageHeader } from "../../components/PageHeader";
import { StatCard } from "../../components/StatCard";
import type { BriefPeriod, BriefStatus } from "../../components/brief-types";
import { COLORS, tint } from "../../components/ui";
import { formatLondonDate, formatLondonTime } from "../../lib/format";
import { requireOrgId } from "../../lib/server/org";

export const dynamic = "force-dynamic";

interface DbRow {
  id: string;
  scope: string;
  period: BriefPeriod;
  projectId: string | null;
  dataSnapshot: Record<string, unknown> | null;
  headline: string;
  status: BriefStatus;
  sentEmailAt: Date | null;
  sentWhatsappAt: Date | null;
  periodStart: Date;
  createdAt: Date;
  projectClientName: string | null;
}

async function loadBriefs(orgId: string): Promise<DbRow[]> {
  return db
    .select({
      id: briefs.id,
      scope: briefs.scope,
      period: briefs.period,
      projectId: briefs.projectId,
      dataSnapshot: briefs.dataSnapshot,
      headline: briefs.headline,
      status: briefs.status,
      sentEmailAt: briefs.sentEmailAt,
      sentWhatsappAt: briefs.sentWhatsappAt,
      periodStart: briefs.periodStart,
      createdAt: briefs.createdAt,
      projectClientName: clients.name,
    })
    .from(briefs)
    .leftJoin(projects, eq(projects.id, briefs.projectId))
    .leftJoin(clients, eq(clients.id, projects.clientId))
    .where(eq(briefs.orgId, orgId))
    .orderBy(desc(briefs.periodStart), desc(briefs.createdAt))
    .limit(200) as unknown as Promise<DbRow[]>;
}

/** A monthly per-client value report / dossier carries clientName in its snapshot. */
function snapshotString(
  snapshot: Record<string, unknown> | null,
  key: string,
): string | null {
  const v = snapshot?.[key];
  return typeof v === "string" ? v : null;
}

export default async function BriefsPage() {
  let rows: BriefRow[] = [];
  let dbError: string | null = null;
  try {
    const orgId = await requireOrgId();
    const dbRows = await loadBriefs(orgId);
    rows = dbRows.map((r) => ({
      id: r.id,
      period: r.period,
      scope: r.scope,
      docType: snapshotString(r.dataSnapshot, "docType"),
      clientName:
        snapshotString(r.dataSnapshot, "clientName") ?? r.projectClientName,
      headline: r.headline,
      periodStartLabel: formatLondonDate(r.periodStart),
      createdLabel: formatLondonTime(r.createdAt),
      status: r.status,
      sentEmailAt: r.sentEmailAt ? r.sentEmailAt.toISOString() : null,
      sentWhatsappAt: r.sentWhatsappAt ? r.sentWhatsappAt.toISOString() : null,
    }));
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const daily = rows.filter((r) => r.period === "daily").length;
  const weekly = rows.filter((r) => r.period === "weekly").length;
  const monthly = rows.filter((r) => r.period === "monthly").length;

  return (
    <div>
      <PageHeader
        title="Briefs"
        subtitle="Every daily, weekly and monthly brief the agents have written — filter by period, scope or client."
        actions={<GenerateBriefButton />}
      />
      <ActivationBanner missing={hasAnthropicKey ? [] : ["ANTHROPIC_API_KEY"]} />

      {!dbError && rows.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 14,
            marginBottom: 20,
          }}
        >
          <StatCard label="Briefs archived" value={<span className="accent-num tnum">{rows.length}</span>} />
          <StatCard label="Daily" value={<span className="tnum">{daily}</span>} />
          <StatCard label="Weekly" value={<span className="tnum">{weekly}</span>} />
          <StatCard label="Monthly" value={<span className="tnum">{monthly}</span>} />
        </div>
      )}

      {dbError ? (
        <div
          className="card"
          style={{
            padding: 20,
            borderColor: tint(COLORS.red, 0.3),
            background: tint(COLORS.red, 0.05),
          }}
        >
          <strong>Database not reachable.</strong>
          <pre
            className="codeblock"
            style={{ marginTop: 12, color: "var(--red)", fontSize: 12 }}
          >
            {dbError}
          </pre>
        </div>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="empty">
            <span className="empty-title">No briefs yet</span>
            <span style={{ fontSize: 13, maxWidth: 420 }}>
              The daily brief runs each morning at 07:00 London; weekly on Monday
              and monthly on the 1st. Generate one now with the button above — in
              demo mode it runs without sending.
            </span>
          </div>
        </div>
      ) : (
        <BriefsBrowser rows={rows} />
      )}
    </div>
  );
}
