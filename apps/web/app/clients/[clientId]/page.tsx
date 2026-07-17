import Link from "next/link";
import { getClientDetail, type ClientDetail } from "../../../lib/server/bookings";
import {
  loadClientBenchmark,
  type ClientBenchmark,
} from "../../../lib/server/benchmarks";
import { getClientChurn, type ChurnScore } from "../../../lib/server/churn";
import { BenchmarkBlock } from "../../../components/BenchmarkBlock";
import { ChurnChip } from "../../../components/ChurnChip";
import { HealthDot } from "../../../components/HealthDot";
import { PageHeader } from "../../../components/PageHeader";
import { StatCard } from "../../../components/StatCard";
import { StatusPill } from "../../../components/StatusPill";
import { humanize } from "../../../components/ui";
import { Pill, type SquircleTone } from "../../../components/system";
import { formatLondonDate, formatLondonTime, formatPence } from "../../../lib/format";
import { requireOrgId } from "../../../lib/server/org";
import { isUuid } from "../../../lib/server/schemas";

export const dynamic = "force-dynamic";

function marginColor(margin: number | null): string {
  if (margin === null) return "var(--text)";
  return margin >= 0 ? "var(--green)" : "var(--red)";
}

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;

  let detail: ClientDetail | null = null;
  let benchmark: ClientBenchmark | null = null;
  let churn: ChurnScore | null = null;
  let dbError: string | null = null;
  let notFound = false;
  if (!isUuid(clientId)) {
    notFound = true;
  } else {
    try {
      const orgId = await requireOrgId();
      detail = await getClientDetail(orgId, clientId);
      if (detail === null) notFound = true;
      else {
        // P8-BENCH: anonymised industry strip (last complete month); null when
        // no industry / below the anonymity floor — the strip simply hides.
        // P9-KB: deterministic churn-risk score (chip beside the status pill).
        [benchmark, churn] = await Promise.all([
          loadClientBenchmark(orgId, clientId),
          getClientChurn(orgId, clientId),
        ]);
      }
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

  const {
    client,
    projects,
    payments,
    bookings,
    insights,
    upsells,
    mrr,
    conversations,
    feedbackOpen,
    recentBriefs,
  } = detail;
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
            {churn ? (
              <ChurnChip
                score={churn.score}
                band={churn.band}
                reasons={churn.reasons}
              />
            ) : null}
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
          value={<span className="accent-num tnum">{formatPence(detail.ltvPence)}</span>}
          sub="Σ paid agency payments"
        />
        <StatCard
          label="Live projects"
          value={<span className="tnum">{activeProjects.toLocaleString("en-GB")}</span>}
          sub={`${projects.length} total`}
        />
        <StatCard
          label="API cost (MTD)"
          value={<span className="tnum">{formatPence(detail.costThisMonthPence)}</span>}
          sub="attributed this month"
          accent={detail.costThisMonthPence > 0 ? "var(--amber)" : undefined}
        />
        <StatCard
          label="Payments"
          value={<span className="tnum">{paidPayments.length.toLocaleString("en-GB")}</span>}
          sub={`${payments.length} on record`}
        />
        <StatCard
          label="MRR share"
          value={
            <span className="tnum">
              {mrr.sharePct === null ? (
                <span className="faint" style={{ fontSize: 20 }}>
                  —
                </span>
              ) : (
                `${(mrr.sharePct * 100).toFixed(1)}%`
              )}
            </span>
          }
          sub={`${formatPence(mrr.clientPence)} of ${formatPence(mrr.orgPence)} org MRR`}
        />
        <StatCard
          label="Cost markup"
          value={
            <span className="tnum">
              {client.costMarkupPct === null ? (
                <span className="faint" style={{ fontSize: 20 }}>
                  —
                </span>
              ) : (
                `${client.costMarkupPct}%`
              )}
            </span>
          }
          sub="applied to attributed API/OS cost"
        />
      </div>

      {/* ── Industry benchmark strip (P8-BENCH) — hidden below the floor ─── */}
      {benchmark ? (
        <div style={{ marginBottom: 26 }}>
          <BenchmarkBlock data={benchmark} variant="strip" />
        </div>
      ) : null}

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
                  <th style={{ textAlign: "right" }}>Events (30d)</th>
                  <th style={{ textAlign: "right" }}>ROI</th>
                  <th style={{ textAlign: "right" }}>Retainer/mo</th>
                  <th style={{ textAlign: "right" }}>Cost (MTD)</th>
                  <th style={{ textAlign: "right" }}>Margin (MTD)</th>
                  <th />
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
                    <td className="mono tnum" style={{ textAlign: "right" }}>
                      {p.eventsLast30d.toLocaleString("en-GB")}
                    </td>
                    <td className="mono tnum" style={{ textAlign: "right" }}>
                      {p.roiMultiple === null ? (
                        <span className="faint">—</span>
                      ) : (
                        `${p.roiMultiple.toFixed(2)}×`
                      )}
                    </td>
                    <td className="mono tnum" style={{ textAlign: "right" }}>
                      {p.retainerActive ? (
                        formatPence(p.retainerPenceMonthly)
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="mono tnum" style={{ textAlign: "right" }}>
                      {formatPence(p.costThisMonthPence)}
                    </td>
                    <td
                      className="mono tnum"
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
                    <td style={{ textAlign: "right" }}>
                      <Link
                        href={`/projects/${p.id}/analytics`}
                        className="faint"
                        style={{ fontSize: 12 }}
                      >
                        Analytics →
                      </Link>
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
                      className="mono tnum"
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

      {/* ── Conversations digest + feedback rollup ───────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 22,
          alignItems: "start",
          marginBottom: 26,
        }}
      >
        <Section
          title="Conversations"
          subtitle="Last 30 days, across all this client's projects."
          flush
        >
          {conversations.total === 0 ? (
            <Empty title="No conversation events in the last 30 days" />
          ) : (
            <div style={{ padding: "14px 18px", display: "grid", gap: 12 }}>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                <MiniStat label="Volume" value={conversations.total.toLocaleString("en-GB")} />
                <MiniStat
                  label="Resolved"
                  value={
                    conversations.resolutionRate === null
                      ? "—"
                      : `${(conversations.resolutionRate * 100).toFixed(0)}%`
                  }
                  color="var(--green)"
                />
                <MiniStat
                  label="Escalated"
                  value={
                    conversations.escalationRate === null
                      ? "—"
                      : `${(conversations.escalationRate * 100).toFixed(0)}%`
                  }
                  color="var(--amber)"
                />
              </div>
              <div className="faint" style={{ fontSize: 12 }}>
                Sentiment — {conversations.sentimentMix.positive} positive ·{" "}
                {conversations.sentimentMix.neutral} neutral ·{" "}
                {conversations.sentimentMix.negative} negative
              </div>
            </div>
          )}
        </Section>

        <Section title="Feedback" subtitle="Open items (not done), by kind." flush>
          {feedbackOpen.length === 0 ? (
            <Empty title="No open feedback items" />
          ) : (
            <ul className="sys-list" style={{ listStyle: "none", padding: "6px 8px" }}>
              {feedbackOpen.map((f) => {
                const tone = FEEDBACK_KIND_TONE[f.kind] ?? "graphite";
                return (
                  <li key={f.kind} className="sys-listrow">
                    <Pill tone={tone}>{humanize(f.kind)}</Pill>
                    <span style={{ flex: 1 }} />
                    <span className="mono tnum" style={{ fontSize: 13, fontWeight: 600 }}>
                      {f.count.toLocaleString("en-GB")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

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
            <ul className="sys-list" style={{ listStyle: "none", padding: "6px 8px" }}>
              {insights.slice(0, 12).map((i) => {
                const tone = KIND_TONE[i.kind] ?? "graphite";
                return (
                  <li key={i.id} className="sys-listrow">
                    <Pill tone={tone}>{humanize(i.kind)}</Pill>
                    <span style={{ flex: 1, fontSize: 13 }}>{i.title}</span>
                    {i.estimatedValuePence != null && (
                      <span className="mono faint tnum" style={{ fontSize: 12 }}>
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
            <ul className="sys-list" style={{ listStyle: "none", padding: "6px 8px" }}>
              {upsells.map((u) => (
                <li key={u.id} className="sys-listrow">
                  <StatusPill status={u.status} />
                  <span style={{ flex: 1, fontSize: 13 }}>{u.title}</span>
                  {u.suggestedPricePence != null && (
                    <span className="mono faint tnum" style={{ fontSize: 12 }}>
                      {formatPence(u.suggestedPricePence)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* ── Recent briefs ─────────────────────────────────────────────── */}
      <Section
        title="Recent briefs"
        subtitle="Project-scoped briefs from any of this client's projects."
      >
        {recentBriefs.length === 0 ? (
          <Empty title="No briefs yet" hint="Daily/weekly/monthly briefs land here once generated." />
        ) : (
          <ul className="sys-list" style={{ listStyle: "none", padding: "6px 8px" }}>
            {recentBriefs.map((b) => (
              <li key={b.id} className="sys-listrow">
                <Pill tone="graphite">
                  <span style={{ textTransform: "capitalize" }}>{b.period}</span>
                </Pill>
                <span style={{ flex: 1, fontSize: 13 }}>
                  {b.headline}
                  {b.projectName && (
                    <span className="faint"> · {b.projectName}</span>
                  )}
                </span>
                <span className="faint mono" style={{ fontSize: 12 }}>
                  {formatLondonDate(b.periodStart)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

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

const KIND_TONE: Record<string, SquircleTone> = {
  automation_opportunity: "lavender",
  upsell: "peach",
  risk: "rose",
  win: "mint",
  anomaly: "butter",
  faq_cluster: "sky",
};

const FEEDBACK_KIND_TONE: Record<string, SquircleTone> = {
  bug: "rose",
  feature: "sky",
  question: "butter",
  praise: "mint",
  other: "graphite",
};

function MiniStat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div>
      <div className="faint" style={{ fontSize: 11.5 }}>
        {label}
      </div>
      <div
        className="tnum"
        style={{ fontSize: 18, fontWeight: 640, color: color ?? "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}

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
      <div style={{ padding: "14px 18px 8px" }}>
        <h3 style={{ fontSize: 14, fontWeight: 620 }}>{title}</h3>
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
