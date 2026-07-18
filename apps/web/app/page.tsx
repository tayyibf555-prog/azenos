import type { ReactNode } from "react";
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
import { HealthAlertsCard } from "../components/HealthAlertsCard";
import {
  CommandCenterPulse,
  type PulseData,
  type PulseProject,
} from "../components/CommandCenterPulse";
import {
  EmptyState,
  EventChip,
  IconSquircle,
  List,
  ListRow,
  PageShell,
  Pill,
  TopbarActions,
  TINTS,
  avatarTone,
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

/**
 * §5 portfolio pulse — the terminal-luxe reference's data. ONE org-scoped,
 * read-only aggregate over the event spine grouped by project × London day for
 * the last 60 London days. That single query feeds every element: per-project
 * 30d-vs-prior-30d deltas (top strip), the combined daily-volume line, the
 * events-share donut, the daily-consistency bars, growth %, conversations and
 * the net-change chip. London boundaries via londonDayUTC (spec §13); same
 * `sql` template style as the sibling loaders above.
 */
async function loadPulse(orgId: string, eventsTotal: number, mrrPence: number): Promise<PulseData> {
  const since60 = londonDayUTC(60);
  const dayExpr = sql<string>`((${events.occurredAt} AT TIME ZONE 'Europe/London')::date)::text`;
  const commsExpr = sql<number>`count(*) filter (where split_part(${events.type}, '.', 1) in ('message', 'email', 'call', 'review'))`;

  const [projectRows, volRows] = await Promise.all([
    db
      .select({ id: projects.id, name: projects.name, clientName: clients.name })
      .from(projects)
      .innerJoin(clients, eq(projects.clientId, clients.id))
      .where(eq(projects.orgId, orgId)),
    db
      .select({
        projectId: events.projectId,
        day: dayExpr,
        n: count(),
        comms: commsExpr.mapWith(Number),
      })
      .from(events)
      .where(and(eq(events.orgId, orgId), gte(events.occurredAt, since60)))
      .groupBy(events.projectId, dayExpr),
  ]);

  // 60 London day keys, oldest → newest (index 59 = today). These match the
  // SQL's `::date::text` output because event times sit inside the London day.
  const dayKeys: string[] = [];
  for (let i = 59; i >= 0; i--) dayKeys.push(londonDayUTC(i).toISOString().slice(0, 10));
  const last30 = dayKeys.slice(30);
  const prev30 = dayKeys.slice(0, 30);
  const last30Set = new Set(last30);

  const byKey = new Map<string, number>(); // `${projectId}|${day}` → count
  const dayTotal = new Map<string, number>();
  let conversations30 = 0;
  for (const r of volRows) {
    const pid = r.projectId ?? "__org__";
    byKey.set(`${pid}|${r.day}`, r.n);
    dayTotal.set(r.day, (dayTotal.get(r.day) ?? 0) + r.n);
    if (last30Set.has(r.day)) conversations30 += r.comms;
  }

  const series60 = dayKeys.map((d) => dayTotal.get(d) ?? 0);

  const pulseProjects: PulseProject[] = projectRows
    .map((p) => {
      const daily = last30.map((d) => byKey.get(`${p.id}|${d}`) ?? 0);
      const cur = daily.reduce((a, b) => a + b, 0);
      const prev = prev30.reduce((a, d) => a + (byKey.get(`${p.id}|${d}`) ?? 0), 0);
      return {
        id: p.id,
        name: p.name,
        clientName: p.clientName,
        cur,
        prev,
        colorHex: TINTS[avatarTone(p.name)].fg,
        daily,
      };
    })
    .sort((a, b) => b.cur - a.cur);

  return {
    projects: pulseProjects,
    seriesDaily: series60.slice(30),
    seriesDays: last30,
    series60,
    eventsTotal,
    conversations30,
    mrrPence,
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

/**
 * RECIPE §2 (Clay rule): cycle a different pastel tint per adjacent tinted card
 * so no two neighbouring upcoming-call cards repeat — the reference's
 * multi-coloured event stack. Purely presentational.
 */
const CALL_TONES: SquircleTone[] = [
  "mint",
  "sky",
  "lavender",
  "butter",
  "peach",
  "rose",
];

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

/** Reflowed §5 rail panel — a hairline card whose header is the uppercase-mono
 * kicker voice (the serif SectionHeader is dropped on this screen), with the
 * rows themselves staying readable sans below it. */
function MonoPanel({ kicker, children }: { kicker: string; children: ReactNode }) {
  return (
    <section className="cc-card" style={{ gap: 12 }}>
      <span className="cc-kicker">{kicker}</span>
      <div>{children}</div>
    </section>
  );
}

export default async function CommandCenter() {
  let overview: Overview | null = null;
  let today: TodayData | null = null;
  let pulse: PulseData | null = null;
  let dbError: string | null = null;
  try {
    const orgId = await requireOrgId();
    [overview, today] = await Promise.all([
      loadOverview(orgId),
      loadToday(orgId),
    ]);
    pulse = await loadPulse(orgId, overview.eventsTotal, overview.mrrPence);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

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
            border: "1px solid rgba(240,112,103,0.3)",
            background: "rgba(240,112,103,0.08)",
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
        overview &&
        pulse && (
          <div style={{ display: "grid", gap: 14 }}>
            {/* §5 the terminal-luxe pulse board (top strip · wide cells · chart
                + donut · consistency bars) — all the agency's real spine data */}
            <CommandCenterPulse data={pulse} />

            {/* §5.1 reflowed rail — Today (wide) + Upcoming calls / Alerts. Mono
                kicker headers; rows stay readable sans. Serif + MiniCalendar
                dropped on this screen (owner reference has none). */}
            <div className="cc-rail">
              <MonoPanel kicker="Today · what needs you">
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
              </MonoPanel>

              <div style={{ display: "grid", gap: 12 }}>
                <MonoPanel kicker="Upcoming calls">
                  {today && today.calls.length > 0 ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      {today.calls.map((c, i) => (
                        <EventChip
                          key={c.id}
                          icon="phone"
                          tone={CALL_TONES[i % CALL_TONES.length]}
                          title={c.inviteeName ?? humanize(c.kind)}
                          time={`${humanize(c.kind)} · ${hm(c.startsAt)}`}
                          countdownTarget={c.startsAt}
                        />
                      ))}
                    </div>
                  ) : (
                    <EmptyState>No discovery, kickoff or review calls today.</EmptyState>
                  )}
                </MonoPanel>

                <MonoPanel kicker="Alerts">
                  <HealthAlertsCard />
                </MonoPanel>
              </div>
            </div>
          </div>
        )
      )}
    </PageShell>
  );
}
