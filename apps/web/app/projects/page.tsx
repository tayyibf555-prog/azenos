import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { clients, db, projects } from "@azen/db";
import { HealthDot } from "../../components/HealthDot";
import { PageHeader } from "../../components/PageHeader";
import { RelativeTime } from "../../components/RelativeTime";
import {
  ProjectSparkline,
  SparklineStrip,
} from "../../components/SparklineStrip";
import { StatusPill } from "../../components/StatusPill";
import { humanize, tint } from "../../components/ui";
import { daysSince, formatPence } from "../../lib/format";
import { requireOrgId } from "../../lib/server/org";

export const dynamic = "force-dynamic";

interface Row {
  id: string;
  name: string;
  slug: string;
  status: string;
  health: string;
  type: string;
  stack: string;
  retainerPenceMonthly: number;
  clientName: string;
  publicKey: string | null;
  lastEventAt: Date | null;
  eventsToday: number;
}

async function loadProjects(orgId: string): Promise<Row[]> {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      status: projects.status,
      health: projects.health,
      type: projects.type,
      stack: projects.stack,
      retainerPenceMonthly: projects.retainerPenceMonthly,
      clientName: clients.name,
      publicKey: sql<
        string | null
      >`(select public_key from project_keys pk where pk.project_id = ${projects.id} and pk.revoked_at is null order by pk.created_at desc limit 1)`,
      lastEventAt: sql<
        Date | null
      >`(select max(occurred_at) from events e where e.project_id = ${projects.id})`,
      // "Today" = current Europe/London day via the rollup engine's SQL
      // boundary (DST-correct; agrees with metric_rollups)
      eventsToday: sql<number>`(select count(*) from events e where e.project_id = ${projects.id} and e.occurred_at >= date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London')`.mapWith(
        Number,
      ),
    })
    .from(projects)
    .innerJoin(clients, eq(projects.clientId, clients.id))
    .where(eq(projects.orgId, orgId))
    .orderBy(desc(projects.createdAt));
}

export default async function ProjectsPage() {
  let rows: Row[] = [];
  let dbError: string | null = null;
  try {
    const orgId = await requireOrgId();
    rows = await loadProjects(orgId);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const newButton = (
    <Link href="/projects/new" className="btn btn-primary">
      + New project
    </Link>
  );

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Every client system wired into the event spine."
        actions={newButton}
      />

      {dbError ? (
        <div className="card empty">
          <span className="empty-title">Couldn&apos;t load projects</span>
          <span className="faint" style={{ fontSize: 12 }}>
            {dbError}
          </span>
        </div>
      ) : rows.length === 0 ? (
        <div className="card empty">
          <span className="empty-title">No projects yet</span>
          <span style={{ fontSize: 13 }}>
            Create your first project to generate an ingest key.
          </span>
          <Link href="/projects/new" className="btn btn-sm" style={{ marginTop: 8 }}>
            + New project
          </Link>
        </div>
      ) : (
        <SparklineStrip>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 14,
          }}
        >
          {rows.map((p) => {
            const silentMs = p.lastEventAt
              ? Date.now() - new Date(p.lastEventAt).getTime()
              : 0;
            const silent =
              p.status === "live" &&
              p.lastEventAt !== null &&
              silentMs > 86_400_000;
            return (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="card hoverable"
                style={{
                  padding: 16,
                  display: "flex",
                  flexDirection: "column",
                  gap: 11,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: 10,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      className="truncate"
                      style={{ fontSize: 15, fontWeight: 600 }}
                    >
                      {p.name}
                    </div>
                    <div className="muted truncate" style={{ fontSize: 12.5 }}>
                      {p.clientName}
                    </div>
                  </div>
                  <HealthDot health={p.health} />
                </div>

                <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                  <StatusPill status={p.status} />
                  <span
                    className="badge"
                    style={{
                      color: "var(--text-2)",
                      background: "var(--card-2)",
                      borderColor: "var(--border)",
                    }}
                  >
                    {humanize(p.type)}
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: "auto",
                    paddingTop: 11,
                    borderTop: "1px solid var(--border)",
                    fontSize: 12.5,
                  }}
                >
                  <span className="muted">
                    {formatPence(p.retainerPenceMonthly)}
                    <span className="faint">/mo</span>
                  </span>
                  <span className="faint">{p.eventsToday} today</span>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 12,
                  }}
                >
                  <div>
                    {silent ? (
                      <span
                        className="badge"
                        style={{
                          color: "var(--red)",
                          background: tint("#f7768e", 0.12),
                          borderColor: tint("#f7768e", 0.3),
                        }}
                      >
                        ● silent {Math.max(1, daysSince(p.lastEventAt!))}d
                      </span>
                    ) : p.lastEventAt ? (
                      <span className="faint">
                        last event <RelativeTime value={p.lastEventAt} />
                      </span>
                    ) : (
                      <span className="faint">no events yet</span>
                    )}
                  </div>
                  <ProjectSparkline projectId={p.id} />
                </div>
              </Link>
            );
          })}
        </div>
        </SparklineStrip>
      )}
    </div>
  );
}
