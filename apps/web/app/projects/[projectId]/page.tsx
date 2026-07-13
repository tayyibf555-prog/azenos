import Link from "next/link";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import {
  clients,
  db,
  events,
  londonDayUTC,
  projectKeys,
  projects,
} from "@azen/db";
import type { ProjectGoal } from "@azen/db";
import { EVENT_TYPES } from "@azen/events";
import { AgentsTab } from "../../../components/AgentsTab";
import { ApiCostsCard } from "../../../components/ApiCostsCard";
import { ConversationsTab } from "../../../components/ConversationsTab";
import { EventsTable } from "../../../components/EventsTable";
import { GoalsList } from "../../../components/GoalsList";
import { HealthDot } from "../../../components/HealthDot";
import { InsightsList } from "../../../components/InsightsList";
import { MetricsTab } from "../../../components/MetricsTab";
import { PageHeader } from "../../../components/PageHeader";
import { RoiCard } from "../../../components/RoiCard";
import { SetupPanel } from "../../../components/SetupPanel";
import { StatCard } from "../../../components/StatCard";
import { StatusPill } from "../../../components/StatusPill";
import { Tabs } from "../../../components/Tabs";
import type { TabDef } from "../../../components/Tabs";
import { eventCategory, tint } from "../../../components/ui";
import type { EventTypeSeen, ProjectKeyView } from "../../../components/types";
import { formatLondonTime, formatPence } from "../../../lib/format";
import { requireOrgId } from "../../../lib/server/org";

export const dynamic = "force-dynamic";

const TABS_WITH_CONTENT = new Set([
  "overview",
  "events",
  "setup",
  "metrics",
  "agents",
  "conversations",
  "insights",
]);

interface Detail {
  project: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    status: string;
    health: string;
    type: string;
    stack: string;
    retainerPenceMonthly: number;
    clientName: string;
    goals: ProjectGoal[];
  };
  keys: ProjectKeyView[];
  activeKey: ProjectKeyView | null;
  eventTypesSeen: EventTypeSeen[];
  stats: { total: number; firstAt: string | null; lastAt: string | null };
  last7: { type: string; count: number }[];
}

async function loadDetail(
  orgId: string,
  projectId: string,
): Promise<Detail | null> {
  const [proj] = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      description: projects.description,
      status: projects.status,
      health: projects.health,
      type: projects.type,
      stack: projects.stack,
      retainerPenceMonthly: projects.retainerPenceMonthly,
      clientName: clients.name,
      goals: projects.goals,
    })
    .from(projects)
    .innerJoin(clients, eq(projects.clientId, clients.id))
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
    .limit(1);
  if (!proj) return null;

  const keyRows = await db
    .select()
    .from(projectKeys)
    .where(
      and(eq(projectKeys.projectId, projectId), eq(projectKeys.orgId, orgId)),
    )
    .orderBy(desc(projectKeys.createdAt));

  const keys: ProjectKeyView[] = keyRows.map((k) => ({
    id: k.id,
    publicKey: k.publicKey,
    authMode: k.authMode,
    rateLimitPer10s: k.rateLimitPer10s,
    createdAt: k.createdAt.toISOString(),
    revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
    lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
    label: k.label ?? null,
  }));
  const activeKey = keys.find((k) => k.revokedAt === null) ?? null;

  // raw sql`` aggregates skip drizzle's decoders — timestamptz arrives as a
  // string ("2026-07-12 16:45:00+00"), so normalize through new Date()
  const toIso = (v: Date | string | null | undefined): string | null =>
    v == null ? null : new Date(v).toISOString();

  const typeRows = await db
    .select({
      type: events.type,
      cnt: count(),
      lastAt: sql<Date | string>`max(${events.occurredAt})`,
    })
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.projectId, projectId)))
    .groupBy(events.type)
    .orderBy(sql`count(*) desc`);
  const eventTypesSeen: EventTypeSeen[] = typeRows.map((r) => ({
    type: r.type,
    count: Number(r.cnt),
    lastAt: toIso(r.lastAt) ?? new Date(0).toISOString(),
  }));

  const [statRow] = await db
    .select({
      total: count(),
      firstAt: sql<Date | string | null>`min(${events.occurredAt})`,
      lastAt: sql<Date | string | null>`max(${events.occurredAt})`,
    })
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.projectId, projectId)));

  const since = londonDayUTC(7);
  const last7Rows = await db
    .select({ type: events.type, cnt: count() })
    .from(events)
    .where(
      and(
        eq(events.orgId, orgId),
        eq(events.projectId, projectId),
        gte(events.occurredAt, since),
      ),
    )
    .groupBy(events.type)
    .orderBy(sql`count(*) desc`);

  return {
    project: proj,
    keys,
    activeKey,
    eventTypesSeen,
    stats: {
      total: Number(statRow?.total ?? 0),
      firstAt: toIso(statRow?.firstAt),
      lastAt: toIso(statRow?.lastAt),
    },
    last7: last7Rows.map((r) => ({ type: r.type, count: Number(r.cnt) })),
  };
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const tabParam = typeof sp.tab === "string" ? sp.tab : "overview";
  const tab = TABS_WITH_CONTENT.has(tabParam) ? tabParam : "overview";

  let detail: Detail | null = null;
  let dbError: string | null = null;
  try {
    const orgId = await requireOrgId();
    detail = await loadDetail(orgId, projectId);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  if (dbError) {
    return (
      <div className="card empty">
        <span className="empty-title">Couldn&apos;t load this project</span>
        <span className="faint" style={{ fontSize: 12 }}>
          {dbError}
        </span>
      </div>
    );
  }
  if (!detail) {
    return (
      <div>
        <PageHeader
          title="Project not found"
          subtitle="It may have been removed, or belong to another workspace."
          actions={
            <Link href="/projects" className="btn">
              ← Projects
            </Link>
          }
        />
      </div>
    );
  }

  const { project, activeKey, eventTypesSeen, stats, last7 } = detail;
  const base = `/projects/${projectId}`;
  const tabs: TabDef[] = [
    { key: "overview", label: "Overview", href: `${base}?tab=overview` },
    { key: "events", label: "Events", href: `${base}?tab=events` },
    { key: "setup", label: "Setup", href: `${base}?tab=setup` },
    { key: "metrics", label: "Metrics", href: `${base}?tab=metrics` },
    {
      key: "conversations",
      label: "Conversations",
      href: `${base}?tab=conversations`,
    },
    { key: "agents", label: "Agents", href: `${base}?tab=agents` },
    { key: "insights", label: "Insights", href: `${base}?tab=insights` },
  ];

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link href="/projects" className="faint" style={{ fontSize: 12.5 }}>
          ← Projects
        </Link>
      </div>

      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 20,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <h1 style={{ fontSize: 22, fontWeight: 650 }}>{project.name}</h1>
            <HealthDot health={project.health} showLabel />
          </div>
          <div className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>
            {project.clientName}
            {project.description ? (
              <span className="faint"> · {project.description}</span>
            ) : null}
          </div>
        </div>
        <div
          style={{ display: "flex", alignItems: "center", gap: 12, flex: "none" }}
        >
          <StatusPill status={project.status} />
          <span style={{ fontSize: 13 }} className="muted">
            {formatPence(project.retainerPenceMonthly)}
            <span className="faint">/mo</span>
          </span>
        </div>
      </header>

      <div style={{ marginBottom: 24 }}>
        <Tabs tabs={tabs} activeKey={tab} />
      </div>

      {tab === "overview" && (
        <OverviewTab
          projectId={project.id}
          goals={project.goals}
          stats={stats}
          last7={last7}
        />
      )}
      {tab === "metrics" && <MetricsTab projectId={project.id} />}
      {tab === "insights" && (
        <div style={{ display: "grid", gap: 22 }}>
          <InsightsList projectId={project.id} />
        </div>
      )}
      {tab === "agents" && <AgentsTab projectId={project.id} />}
      {tab === "conversations" && <ConversationsTab projectId={project.id} />}
      {tab === "events" && (
        <EventsTable
          projectId={projectId}
          typeOptions={eventTypesSeen.map((e) => e.type)}
        />
      )}
      {tab === "setup" && (
        <SetupPanel
          projectId={projectId}
          activeKey={activeKey}
          eventTypesSeen={eventTypesSeen}
          eventTypes={[...EVENT_TYPES]}
          hasEvents={stats.total > 0}
        />
      )}
    </div>
  );
}

function OverviewTab({
  projectId,
  goals,
  stats,
  last7,
}: {
  projectId: string;
  goals: ProjectGoal[];
  stats: { total: number; firstAt: string | null; lastAt: string | null };
  last7: { type: string; count: number }[];
}) {
  const max = last7.reduce((m, r) => Math.max(m, r.count), 0) || 1;
  return (
    <div style={{ display: "grid", gap: 22 }}>
      <RoiCard projectId={projectId} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 22,
          alignItems: "start",
        }}
      >
        <GoalsList projectId={projectId} goals={goals} />
        <ApiCostsCard projectId={projectId} />
      </div>

      <InsightsList projectId={projectId} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: 14,
        }}
      >
        <StatCard
          label="Total events"
          value={stats.total.toLocaleString("en-GB")}
        />
        <StatCard
          label="First event"
          value={
            stats.firstAt ? (
              <span style={{ fontSize: 17 }}>
                {formatLondonTime(stats.firstAt)}
              </span>
            ) : (
              "—"
            )
          }
        />
        <StatCard
          label="Last event"
          value={
            stats.lastAt ? (
              <span style={{ fontSize: 17 }}>
                {formatLondonTime(stats.lastAt)}
              </span>
            ) : (
              "—"
            )
          }
        />
      </div>

      <section className="card" style={{ padding: 0 }}>
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h3 style={{ fontSize: 14 }}>Event types · last 7 days</h3>
        </div>
        {last7.length === 0 ? (
          <div className="empty">
            <span className="empty-title">No events in the last 7 days</span>
            <span style={{ fontSize: 13 }}>
              Send one from the Setup tab to see activity here.
            </span>
          </div>
        ) : (
          <div style={{ padding: "14px 18px", display: "grid", gap: 9 }}>
            {last7.map((r) => {
              const cat = eventCategory(r.type);
              return (
                <div
                  key={r.type}
                  style={{ display: "flex", alignItems: "center", gap: 12 }}
                >
                  <span
                    className="badge badge-mono"
                    style={{
                      color: cat.color,
                      background: tint(cat.color, 0.12),
                      borderColor: tint(cat.color, 0.26),
                      flex: "none",
                      width: 190,
                      justifyContent: "flex-start",
                    }}
                  >
                    {r.type}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: 8,
                      borderRadius: 4,
                      background: "var(--card-2)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${(r.count / max) * 100}%`,
                        height: "100%",
                        background: cat.color,
                        opacity: 0.8,
                      }}
                    />
                  </div>
                  <span
                    className="mono"
                    style={{ flex: "none", width: 56, textAlign: "right", fontSize: 12.5 }}
                  >
                    {r.count.toLocaleString("en-GB")}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
