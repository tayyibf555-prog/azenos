import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  bookings,
  clients,
  db,
  events,
  insights,
  londonDayUTC,
  londonMonthStartUTC,
  londonTodayUTC,
  payments,
  projects,
  subscriptions,
} from "@azen/db";
import { InlineBrief } from "../components/InlineBrief";
import { OverviewHealth } from "../components/OverviewHealth";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/StatCard";
import { Ticker } from "../components/Ticker";
import {
  TodayColumn,
  type TodayData,
} from "../components/TodayColumn";
import { formatPence } from "../lib/format";
import { requireOrgId } from "../lib/server/org";

export const dynamic = "force-dynamic";

interface Overview {
  mrrPence: number;
  activeClients: number;
  liveProjects: number;
  eventsTotal: number;
  clientBookingsThisMonth: number;
}

async function loadOverview(orgId: string): Promise<Overview> {
  const monthStart = londonMonthStartUTC(0);
  const [mrr] = await db
    .select({
      v: sql<number>`coalesce(sum(${subscriptions.amountPenceMonthly}), 0)`.mapWith(
        Number,
      ),
    })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "active")),
    );
  const [cl] = await db
    .select({ v: count() })
    .from(clients)
    .where(and(eq(clients.orgId, orgId), eq(clients.status, "active")));
  const [pr] = await db
    .select({ v: count() })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.status, "live")));
  const [ev] = await db
    .select({ v: count() })
    .from(events)
    .where(eq(events.orgId, orgId));
  const [bk] = await db
    .select({ v: count() })
    .from(bookings)
    .where(
      and(
        eq(bookings.orgId, orgId),
        eq(bookings.kind, "client_end_customer"),
        gte(bookings.startsAt, monthStart),
      ),
    );
  return {
    mrrPence: Number(mrr?.v ?? 0),
    activeClients: Number(cl?.v ?? 0),
    liveProjects: Number(pr?.v ?? 0),
    eventsTotal: Number(ev?.v ?? 0),
    clientBookingsThisMonth: Number(bk?.v ?? 0),
  };
}

/** §5.1 "Today" column: agency calls today, overdue payments, new insights. */
async function loadToday(orgId: string): Promise<TodayData> {
  const todayStart = londonTodayUTC();
  const tomorrowStart = londonDayUTC(-1);
  const now = new Date();

  const callRows = await db
    .select({
      id: bookings.id,
      kind: bookings.kind,
      startsAt: bookings.startsAt,
      status: bookings.status,
      invitee: bookings.invitee,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.orgId, orgId),
        inArray(bookings.kind, ["discovery", "kickoff", "review"]),
        gte(bookings.startsAt, todayStart),
        lt(bookings.startsAt, tomorrowStart),
      ),
    )
    .orderBy(bookings.startsAt)
    .limit(20);

  // Overdue expected payments: pending agency invoices whose paid_at (the
  // expected date) is in the past. Empty pre-Phase-4 (no payments seeded yet).
  const payRows = await db
    .select({
      id: payments.id,
      amountPence: payments.amountPence,
      kind: payments.kind,
      clientName: clients.name,
    })
    .from(payments)
    .innerJoin(clients, eq(payments.clientId, clients.id))
    .where(
      and(
        eq(payments.orgId, orgId),
        eq(payments.status, "pending"),
        lt(payments.paidAt, now),
      ),
    )
    .orderBy(payments.paidAt)
    .limit(20);

  const insightRows = await db
    .select({
      id: insights.id,
      projectId: insights.projectId,
      projectName: projects.name,
      title: insights.title,
      kind: insights.kind,
      confidence: insights.confidence,
      createdAt: insights.createdAt,
    })
    .from(insights)
    .innerJoin(projects, eq(insights.projectId, projects.id))
    .where(and(eq(insights.orgId, orgId), eq(insights.status, "new")))
    .orderBy(desc(insights.createdAt))
    .limit(8);

  const inviteeName = (invitee: Record<string, unknown> | null): string | null => {
    if (!invitee) return null;
    const name = invitee["name"] ?? invitee["email"];
    return typeof name === "string" ? name : null;
  };

  return {
    calls: callRows.map((r) => ({
      id: r.id,
      kind: r.kind,
      startsAt: r.startsAt.toISOString(),
      inviteeName: inviteeName(r.invitee),
      status: r.status,
    })),
    overduePayments: payRows.map((r) => ({
      id: r.id,
      clientName: r.clientName,
      amountPence: Number(r.amountPence),
      kind: r.kind,
    })),
    newInsights: insightRows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      projectName: r.projectName,
      title: r.title,
      kind: r.kind,
      confidence: r.confidence,
    })),
  };
}

export default async function CommandCenter() {
  let overview: Overview | null = null;
  let today: TodayData | null = null;
  let dbError: string | null = null;
  try {
    const orgId = await requireOrgId();
    [overview, today] = await Promise.all([
      loadOverview(orgId),
      loadToday(orgId),
    ]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  return (
    <div>
      <PageHeader
        title="Command Center"
        subtitle="How the whole agency is doing, right now."
      />

      {dbError ? (
        <div
          className="card"
          style={{
            padding: 20,
            borderColor: "rgba(247,118,142,0.3)",
            background: "rgba(247,118,142,0.05)",
          }}
        >
          <strong>Database not reachable.</strong>
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            Run <code className="kbd">pnpm db:local</code>,{" "}
            <code className="kbd">pnpm db:migrate</code>, then{" "}
            <code className="kbd">pnpm seed:demo</code>.
          </p>
          <pre
            className="codeblock"
            style={{ marginTop: 12, color: "var(--red)", fontSize: 12 }}
          >
            {dbError}
          </pre>
        </div>
      ) : (
        overview && (
          <div style={{ display: "grid", gap: 22 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                gap: 14,
              }}
            >
              <StatCard
                label="Monthly recurring revenue"
                value={formatPence(overview.mrrPence)}
                accent="var(--green)"
              />
              <StatCard label="Active clients" value={overview.activeClients} />
              <StatCard label="Live projects" value={overview.liveProjects} />
              <StatCard
                label="Events in the spine"
                value={overview.eventsTotal.toLocaleString("en-GB")}
              />
            </div>

            <OverviewHealth />

            <div
              className="card"
              style={{
                padding: "18px 22px",
                display: "flex",
                alignItems: "center",
                gap: 16,
                background:
                  "linear-gradient(90deg, rgba(122,162,247,0.08), transparent 70%)",
              }}
            >
              <div
                style={{
                  fontSize: 34,
                  fontWeight: 720,
                  letterSpacing: "-0.02em",
                  color: "var(--accent)",
                }}
              >
                {overview.clientBookingsThisMonth.toLocaleString("en-GB")}
              </div>
              <div style={{ fontSize: 14.5, lineHeight: 1.45 }}>
                appointments our systems booked for clients this month.
                <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>
                  Mirrored from every <code className="mono">booking.*</code>{" "}
                  event across live projects.
                </div>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                gap: 14,
                alignItems: "start",
              }}
            >
              {today && <TodayColumn data={today} />}
              <InlineBrief />
            </div>

            <Ticker />
          </div>
        )
      )}
    </div>
  );
}
