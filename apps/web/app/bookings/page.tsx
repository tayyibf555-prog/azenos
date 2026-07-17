import Link from "next/link";
import {
  getAgencyBookings,
  getClientEndBookings,
  type AgencyBookings,
  type ClientEndBookings,
} from "../../lib/server/bookings";
import { PageHeader } from "../../components/PageHeader";
import { StatCard } from "../../components/StatCard";
import { Pill, TINTS, type SquircleTone } from "../../components/system";
import { humanize } from "../../components/ui";
import { formatLondonTime } from "../../lib/format";
import { requireOrgId } from "../../lib/server/org";
import { londonDayUTC } from "@azen/db";

export const dynamic = "force-dynamic";

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

export default async function BookingsPage() {
  let agency: AgencyBookings | null = null;
  let clientEnd: ClientEndBookings | null = null;
  let dbError: string | null = null;
  try {
    const orgId = await requireOrgId();
    const from = londonDayUTC(90);
    const to = londonDayUTC(-1); // start of tomorrow (London) → today included
    [agency, clientEnd] = await Promise.all([
      getAgencyBookings(orgId, { from, to }),
      getClientEndBookings(orgId),
    ]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  if (dbError) {
    return (
      <div>
        <PageHeader
          title="Bookings"
          subtitle="Agency calls and the appointments our systems book for clients."
        />
        <div className="card empty">
          <span className="empty-title">Couldn&apos;t load bookings</span>
          <span className="faint" style={{ fontSize: 12 }}>
            {dbError}
          </span>
        </div>
      </div>
    );
  }
  if (!agency || !clientEnd) return null;

  return (
    <div>
      <PageHeader
        title="Bookings"
        subtitle="Agency calls (Calendly) over the last 90 days, plus the appointments our systems book for clients this month."
      />

      {/* ── Agency call stats ─────────────────────────────────────────── */}
      <section style={{ marginBottom: 26 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 14,
          }}
        >
          <StatCard
            label="Upcoming calls"
            value={<span className="tnum">{agency.upcoming.length.toLocaleString("en-GB")}</span>}
            sub="scheduled, from now"
          />
          <StatCard
            label="Show rate"
            value={<span className="tnum">{pct(agency.rates.showRate)}</span>}
            sub={`${agency.window.completed}/${agency.rates.resolved} resolved`}
            accent="var(--green)"
          />
          <StatCard
            label="No-show rate"
            value={<span className="tnum">{pct(agency.rates.noShowRate)}</span>}
            sub={`${agency.window.noShow} no-shows`}
            accent={agency.window.noShow > 0 ? "var(--amber)" : undefined}
          />
          <StatCard
            label="Cancel rate"
            value={<span className="tnum">{pct(agency.rates.cancelRate)}</span>}
            sub={`${agency.window.cancelled} cancelled`}
            accent={agency.window.cancelled > 0 ? "var(--red)" : undefined}
          />
        </div>
      </section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 22,
          alignItems: "start",
          marginBottom: 26,
        }}
      >
        {/* ── Source of booked calls ──────────────────────────────────── */}
        <section className="card" style={{ padding: 0 }}>
          <div style={{ padding: "14px 18px 8px" }}>
            <h3 style={{ fontSize: 14, fontWeight: 620 }}>Source of booked calls</h3>
            <span className="faint" style={{ fontSize: 12 }}>
              Where the agency&apos;s calls came from · {agency.window.total} in
              window
            </span>
          </div>
          {agency.sources.length === 0 ? (
            <div className="empty">
              <span className="empty-title">No calls in this window</span>
            </div>
          ) : (
            <div style={{ padding: "6px 18px 16px", display: "grid", gap: 10 }}>
              {agency.sources.map((s) => {
                const max = agency.sources[0]?.count || 1;
                return (
                  <div
                    key={s.source}
                    style={{ display: "flex", alignItems: "center", gap: 12 }}
                  >
                    <span
                      style={{
                        flex: "none",
                        width: 110,
                        fontSize: 12.5,
                        textTransform: "capitalize",
                      }}
                    >
                      {humanize(s.source)}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: 8,
                        borderRadius: 4,
                        background: "var(--bg-well)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${(s.count / max) * 100}%`,
                          height: "100%",
                          background: TINTS.sky.fg,
                        }}
                      />
                    </div>
                    <span
                      className="mono tnum"
                      style={{
                        flex: "none",
                        width: 44,
                        textAlign: "right",
                        fontSize: 12.5,
                      }}
                    >
                      {s.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Discovery → client conversion funnel ────────────────────── */}
        <section className="card" style={{ padding: 0 }}>
          <div style={{ padding: "14px 18px 8px" }}>
            <h3 style={{ fontSize: 14, fontWeight: 620 }}>Discovery → client conversion</h3>
            <span className="faint" style={{ fontSize: 12 }}>
              Discovery calls that became active clients ·{" "}
              {pct(agency.conversion.rate)} converted
            </span>
          </div>
          <div style={{ padding: "6px 18px 16px", display: "grid", gap: 9 }}>
            <FunnelRow
              label="Discovery booked"
              value={agency.conversion.discoveryBooked}
              max={agency.conversion.discoveryBooked}
              tone="graphite"
            />
            <FunnelRow
              label="Completed"
              value={agency.conversion.discoveryCompleted}
              max={agency.conversion.discoveryBooked}
              tone="sky"
            />
            <FunnelRow
              label="Linked to a client"
              value={agency.conversion.linkedToClient}
              max={agency.conversion.discoveryBooked}
              tone="lavender"
            />
            <FunnelRow
              label="Client now active"
              value={agency.conversion.convertedToActive}
              max={agency.conversion.discoveryBooked}
              tone="mint"
            />
          </div>
        </section>
      </div>

      {/* ── The marketing stat: cross-project client-end rollup ───────── */}
      <section className="card" style={{ padding: 0, marginBottom: 26 }}>
        <div
          style={{
            padding: "16px 18px 12px",
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 620 }}>Appointments booked for clients</h3>
            <span className="faint" style={{ fontSize: 12 }}>
              What our systems booked for clients this month ({clientEnd.month})
            </span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              className="accent-num tnum"
              style={{
                fontSize: 30,
                fontWeight: 680,
                letterSpacing: "-0.02em",
              }}
            >
              {clientEnd.total.toLocaleString("en-GB")}
            </div>
            <div className="faint tnum" style={{ fontSize: 11 }}>
              {clientEnd.completed} completed · {clientEnd.noShow} no-show
            </div>
          </div>
        </div>
        {clientEnd.byProject.length === 0 ? (
          <div className="empty">
            <span className="empty-title">
              No client appointments booked this month yet
            </span>
            <span style={{ fontSize: 13 }}>
              Client-system booking.* events mirror here as they arrive.
            </span>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Client</th>
                  <th style={{ textAlign: "right" }}>Booked</th>
                  <th style={{ textAlign: "right" }}>Completed</th>
                  <th style={{ textAlign: "right" }}>No-show</th>
                  <th style={{ textAlign: "right" }}>Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {clientEnd.byProject.map((p) => (
                  <tr key={p.projectId || p.projectName}>
                    <td style={{ fontWeight: 550 }}>
                      {p.projectId ? (
                        <Link href={`/projects/${p.projectId}`}>
                          {p.projectName}
                        </Link>
                      ) : (
                        p.projectName
                      )}
                    </td>
                    <td className="muted">
                      {p.clientId ? (
                        <Link href={`/clients/${p.clientId}`}>
                          {p.clientName}
                        </Link>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td
                      className="mono tnum"
                      style={{ textAlign: "right", fontWeight: 600 }}
                    >
                      {p.count}
                    </td>
                    <td className="mono tnum" style={{ textAlign: "right" }}>
                      {p.completed}
                    </td>
                    <td className="mono tnum" style={{ textAlign: "right" }}>
                      {p.noShow}
                    </td>
                    <td className="mono tnum" style={{ textAlign: "right" }}>
                      {p.scheduled}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Upcoming agency calls ─────────────────────────────────────── */}
      <section className="card" style={{ padding: 0 }}>
        <div style={{ padding: "14px 18px 8px" }}>
          <h3 style={{ fontSize: 14, fontWeight: 620 }}>Upcoming agency calls</h3>
        </div>
        {agency.upcoming.length === 0 ? (
          <div className="empty">
            <span className="empty-title">No upcoming calls scheduled</span>
            <span style={{ fontSize: 13 }}>
              New Calendly bookings appear here automatically.
            </span>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Invitee</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {agency.upcoming.map((b) => {
                  const name =
                    (b.invitee && typeof b.invitee["name"] === "string"
                      ? (b.invitee["name"] as string)
                      : null) ?? "—";
                  const tone = KIND_TONE[b.kind] ?? "graphite";
                  return (
                    <tr key={b.id}>
                      <td className="mono tnum" style={{ fontSize: 12.5 }}>
                        {formatLondonTime(b.startsAt)}
                      </td>
                      <td>
                        <Pill tone={tone}>{humanize(b.kind)}</Pill>
                      </td>
                      <td>{name}</td>
                      <td className="muted" style={{ textTransform: "capitalize" }}>
                        {humanize(b.source)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const KIND_TONE: Record<string, SquircleTone> = {
  discovery: "sky",
  kickoff: "lavender",
  review: "mint",
};

function FunnelRow({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone: SquircleTone;
}) {
  const width = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ flex: "none", width: 130, fontSize: 12.5 }}>{label}</span>
      <div
        style={{
          flex: 1,
          height: 18,
          borderRadius: 5,
          background: "var(--bg-well)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${width}%`,
            height: "100%",
            background: TINTS[tone].fg,
            transition: "width .2s",
          }}
        />
      </div>
      <span
        className="mono tnum"
        style={{ flex: "none", width: 36, textAlign: "right", fontSize: 12.5 }}
      >
        {value}
      </span>
    </div>
  );
}
