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
import { Ticker } from "../components/Ticker";
import { ProjectHealthTable } from "../components/ProjectHealthTable";
import { OpenAnomaliesStat } from "../components/OpenAnomaliesStat";
import { HealthAlertsCard } from "../components/HealthAlertsCard";
import {
  CountdownPill,
  DataCard,
  EmptyState,
  EventChip,
  IconSquircle,
  List,
  ListRow,
  MiniCalendar,
  PageShell,
  Pill,
  StatCell,
  StatRow,
  TopbarActions,
  type CalendarEvent,
  type SquircleTone,
} from "../components/system";
import { type TodayData } from "../components/TodayColumn";
import { formatPence } from "../lib/format";
import { humanize } from "../components/ui";
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

const CONFIDENCE_TONE: Record<string, SquircleTone> = {
  high: "rose",
  med: "butter",
  low: "graphite",
};

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

  const calendarEvents: CalendarEvent[] =
    today?.calls.map((c) => ({ date: c.startsAt, tone: "mint" as const })) ?? [];

  const needsYouCount =
    (today?.newInsights.length ?? 0) + (today?.overduePayments.length ?? 0);

  return (
    <PageShell
      crumbs={[{ label: "Azen AI", href: "/" }, { label: "Command Center" }]}
      sectionIcon="grid"
      actions={<TopbarActions notify={needsYouCount > 0} />}
    >
      {dbError ? (
        <div
          className="card"
          style={{
            padding: 20,
            borderColor: "rgba(212,82,74,0.3)",
            background: "rgba(212,82,74,0.06)",
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
          <div style={{ display: "grid", gap: 14 }}>
            {/* §5 one compact stat strip */}
            <StatRow>
              <StatCell
                label="Monthly recurring revenue"
                value={formatPence(overview.mrrPence)}
                hero
              />
              <StatCell
                label="Active clients"
                value={overview.activeClients.toLocaleString("en-GB")}
              />
              <StatCell
                label="Live projects"
                value={overview.liveProjects.toLocaleString("en-GB")}
              />
              <StatCell
                label="Events in spine"
                value={overview.eventsTotal.toLocaleString("en-GB")}
              />
              <StatCell
                label="Appointments this month"
                value={overview.clientBookingsThisMonth.toLocaleString("en-GB")}
              />
              <OpenAnomaliesStat />
            </StatRow>

            {/* §5 2fr / 1fr dashboard grid */}
            <div className="sys-dash-grid">
              <div className="sys-col">
                <DataCard
                  title="Today — what needs you"
                  caption="Insights to review and money to chase"
                  icon="flag"
                  tone="peach"
                >
                  {today && needsYouCount > 0 ? (
                    <List>
                      {today.newInsights.map((ins) => (
                        <ListRow
                          key={ins.id}
                          href={`/projects/${ins.projectId}`}
                          leading={
                            <IconSquircle
                              tone={CONFIDENCE_TONE[ins.confidence] ?? "graphite"}
                              icon="bulb"
                              size={28}
                            />
                          }
                          primary={ins.title}
                          secondary={`${humanize(ins.kind)} · ${ins.projectName}`}
                          meta={
                            <Pill tone={CONFIDENCE_TONE[ins.confidence] ?? "graphite"}>
                              {ins.confidence}
                            </Pill>
                          }
                        />
                      ))}
                      {today.overduePayments.map((p) => (
                        <ListRow
                          key={p.id}
                          leading={<IconSquircle tone="rose" icon="pound" size={28} />}
                          primary={p.clientName}
                          secondary={`${humanize(p.kind)} · overdue`}
                          meta={
                            <span
                              className="tnum"
                              style={{ fontSize: 13, fontWeight: 600, color: "var(--red)" }}
                            >
                              {formatPence(p.amountPence)}
                            </span>
                          }
                        />
                      ))}
                    </List>
                  ) : (
                    <EmptyState>Nothing needs you right now — you&apos;re clear.</EmptyState>
                  )}
                </DataCard>

                <DataCard
                  title="Project health"
                  caption="Live across every client system"
                  icon="box"
                  tone="sky"
                >
                  <ProjectHealthTable />
                </DataCard>

                <Ticker />
              </div>

              <div className="sys-col">
                <DataCard title="Calendar" icon="calendar" tone="lavender">
                  <MiniCalendar events={calendarEvents} />
                </DataCard>

                <DataCard title="Upcoming calls" icon="phone" tone="mint">
                  {today && today.calls.length > 0 ? (
                    <div style={{ display: "grid", gap: 2 }}>
                      {today.calls.map((c) => (
                        <EventChip
                          key={c.id}
                          icon="phone"
                          tone="mint"
                          title={c.inviteeName ?? humanize(c.kind)}
                          time={`${humanize(c.kind)} · ${hm(c.startsAt)}`}
                          meta={<CountdownPill target={c.startsAt} />}
                        />
                      ))}
                    </div>
                  ) : (
                    <EmptyState>No discovery, kickoff or review calls today.</EmptyState>
                  )}
                </DataCard>

                <DataCard title="Alerts" icon="alert" tone="rose">
                  <HealthAlertsCard />
                </DataCard>
              </div>
            </div>
          </div>
        )
      )}
    </PageShell>
  );
}
