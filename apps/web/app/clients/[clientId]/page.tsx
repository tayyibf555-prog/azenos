import Link from "next/link";
import { getClientDetail, type ClientDetail } from "../../../lib/server/bookings";
import { HealthDot } from "../../../components/HealthDot";
import { PageHeader } from "../../../components/PageHeader";
import { StatCard } from "../../../components/StatCard";
import { StatusPill } from "../../../components/StatusPill";
import { COLORS, humanize, tint } from "../../../components/ui";
import { formatLondonDate, formatLondonTime, formatPence } from "../../../lib/format";
import { requireOrgId } from "../../../lib/server/org";
import { isUuid } from "../../../lib/server/schemas";

export const dynamic = "force-dynamic";

function marginColor(margin: number | null): string {
  if (margin === null) return "var(--text)";
  return margin >= 0 ? COLORS.green : COLORS.red;
}

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;

  let detail: ClientDetail | null = null;
  let dbError: string | null = null;
  let notFound = false;
  if (!isUuid(clientId)) {
    notFound = true;
  } else {
    try {
      const orgId = await requireOrgId();
      detail = await getClientDetail(orgId, clientId);
      if (detail === null) notFound = true;
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }
  }

  if (dbError) {
    return (
      <div className="card empty">
        <span className="empty-title">Couldn&apos;t load this client</span>
        <span className="faint" style={{ fontSize: 12 }}>
          {dbError}
        </span>
      </div>
    );
  }
  if (notFound || !detail) {
    return (
      <div>
        <PageHeader
          title="Client not found"
          subtitle="It may have been removed, or belong to another workspace."
          actions={
            <Link href="/clients" className="btn">
              ← Clients
            </Link>
          }
        />
      </div>
    );
  }

  const { client, projects, payments, bookings, insights, upsells } = detail;
  const paidPayments = payments.filter((p) => p.status === "paid");
  const activeProjects = projects.filter((p) => p.status === "live").length;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link href="/clients" className="faint" style={{ fontSize: 12.5 }}>
          ← Clients
        </Link>
      </div>

      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 22,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <h1 style={{ fontSize: 22, fontWeight: 650 }}>{client.name}</h1>
            <StatusPill status={client.status} />
          </div>
          <div className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>
            {client.company ? <span>{client.company}</span> : null}
            {client.industrySlug ? (
              <span className="faint">
                {client.company ? " · " : ""}
                {client.industrySlug}
              </span>
            ) : null}
            {client.website ? (
              <span className="faint"> · {client.website}</span>
            ) : null}
          </div>
        </div>
        <div className="faint" style={{ fontSize: 12, flex: "none", textAlign: "right" }}>
          Client since
          <div style={{ fontSize: 13, color: "var(--text-2)" }}>
            {formatLondonDate(client.createdAt)}
          </div>
        </div>
      </header>

      {/* ── Relationship stats ────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 14,
          marginBottom: 26,
        }}
      >
        <StatCard
          label="Lifetime value"
          value={formatPence(detail.ltvPence)}
          sub="Σ paid agency payments"
          accent={COLORS.green}
        />
        <StatCard
          label="Live projects"
          value={activeProjects.toLocaleString("en-GB")}
          sub={`${projects.length} total`}
        />
        <StatCard
          label="API cost (MTD)"
          value={formatPence(detail.costThisMonthPence)}
          sub="attributed this month"
          accent={detail.costThisMonthPence > 0 ? COLORS.amber : undefined}
        />
        <StatCard
          label="Payments"
          value={paidPayments.length.toLocaleString("en-GB")}
          sub={`${payments.length} on record`}
        />
      </div>

      {/* ── Projects (with margin) ────────────────────────────────────── */}
      <Section
        title="Projects"
        subtitle="Retainer minus attributed API/OS cost this month = margin."
      >
        {projects.length === 0 ? (
          <Empty title="No projects yet" />
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Retainer/mo</th>
                  <th style={{ textAlign: "right" }}>Cost (MTD)</th>
                  <th style={{ textAlign: "right" }}>Margin (MTD)</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 550 }}>
                      <span
                        style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
                      >
                        <HealthDot health={p.health} />
                        <Link href={`/projects/${p.id}`}>{p.name}</Link>
                      </span>
                    </td>
                    <td>
                      <StatusPill status={p.status} />
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {p.retainerActive ? (
                        formatPence(p.retainerPenceMonthly)
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {formatPence(p.costThisMonthPence)}
                    </td>
                    <td
                      className="mono"
                      style={{
                        textAlign: "right",
                        color: marginColor(p.marginPence),
                        fontWeight: 600,
                      }}
                    >
                      {p.marginPence === null ? (
                        <span className="faint">—</span>
                      ) : (
                        formatPence(p.marginPence)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Payments + LTV ────────────────────────────────────────────── */}
      <Section
        title="Payments"
        subtitle={`Agency ledger only. Lifetime value = ${formatPence(detail.ltvPence)}.`}
      >
        {payments.length === 0 ? (
          <Empty title="No payments recorded" />
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Paid</th>
                  <th>Kind</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Ref</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="mono" style={{ fontSize: 12.5 }}>
                      {p.paidAt ? formatLondonDate(p.paidAt) : <span className="faint">—</span>}
                    </td>
                    <td style={{ textTransform: "capitalize" }}>{humanize(p.kind)}</td>
                    <td className="muted" style={{ textTransform: "capitalize" }}>
                      {humanize(p.source)}
                    </td>
                    <td>
                      <StatusPill status={p.status} />
                    </td>
                    <td className="muted mono" style={{ fontSize: 12 }}>
                      {p.invoiceRef ?? <span className="faint">—</span>}
                    </td>
                    <td
                      className="mono"
                      style={{ textAlign: "right", fontWeight: 600 }}
                    >
                      {formatPence(p.amountPence)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Bookings ──────────────────────────────────────────────────── */}
      <Section
        title="Bookings"
        subtitle="Agency calls with this client and appointments their systems booked."
      >
        {bookings.length === 0 ? (
          <Empty title="No bookings for this client" />
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Source</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {bookings.slice(0, 25).map((b) => (
                  <tr key={b.id}>
                    <td className="mono" style={{ fontSize: 12.5 }}>
                      {formatLondonTime(b.startsAt)}
                    </td>
                    <td style={{ textTransform: "capitalize" }}>{humanize(b.kind)}</td>
                    <td className="muted" style={{ textTransform: "capitalize" }}>
                      {humanize(b.source)}
                    </td>
                    <td>
                      <StatusPill status={b.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Insights + upsells ────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 22,
          alignItems: "start",
          marginBottom: 26,
        }}
      >
        <Section title="Insights" flush>
          {insights.length === 0 ? (
            <Empty title="No insights yet" hint="The Opportunity Scout fills this in Phase 6." />
          ) : (
            <ul style={{ listStyle: "none", display: "grid", gap: 1 }}>
              {insights.slice(0, 12).map((i) => {
                const c = KIND_COLOR[i.kind] ?? COLORS.grey;
                return (
                  <li
                    key={i.id}
                    style={{
                      padding: "11px 18px",
                      borderTop: "1px solid var(--border)",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <span
                      className="badge"
                      style={{
                        color: c,
                        background: tint(c, 0.13),
                        borderColor: tint(c, 0.28),
                        flex: "none",
                      }}
                    >
                      {humanize(i.kind)}
                    </span>
                    <span style={{ flex: 1, fontSize: 13 }}>{i.title}</span>
                    {i.estimatedValuePence != null && (
                      <span className="mono faint" style={{ fontSize: 12 }}>
                        {formatPence(i.estimatedValuePence)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Upsell proposals" flush>
          {upsells.length === 0 ? (
            <Empty title="No proposals yet" hint="The Upsell Engine writes these in Phase 6." />
          ) : (
            <ul style={{ listStyle: "none", display: "grid", gap: 1 }}>
              {upsells.map((u) => (
                <li
                  key={u.id}
                  style={{
                    padding: "11px 18px",
                    borderTop: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <StatusPill status={u.status} />
                  <span style={{ flex: 1, fontSize: 13 }}>{u.title}</span>
                  {u.suggestedPricePence != null && (
                    <span className="mono faint" style={{ fontSize: 12 }}>
                      {formatPence(u.suggestedPricePence)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* ── Notes ─────────────────────────────────────────────────────── */}
      {client.notes ? (
        <Section title="Notes">
          <div style={{ padding: "14px 18px", fontSize: 13.5, whiteSpace: "pre-wrap" }}>
            {client.notes}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

const KIND_COLOR: Record<string, string> = {
  automation_opportunity: COLORS.blue,
  upsell: COLORS.violet,
  risk: COLORS.red,
  win: COLORS.green,
  anomaly: COLORS.amber,
  faq_cluster: COLORS.teal,
};

function Section({
  title,
  subtitle,
  children,
  flush,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="card" style={{ padding: 0, marginBottom: flush ? 0 : 26 }}>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
        <h3 style={{ fontSize: 14 }}>{title}</h3>
        {subtitle && (
          <span className="faint" style={{ fontSize: 12 }}>
            {subtitle}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <span className="empty-title">{title}</span>
      {hint && <span style={{ fontSize: 13 }}>{hint}</span>}
    </div>
  );
}
