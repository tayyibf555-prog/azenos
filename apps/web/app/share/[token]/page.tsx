import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { loadClientBenchmark } from "../../../lib/server/benchmarks";
import { loadSharedProposal } from "../../../lib/server/growth";
import {
  loadSharedMonthlyReport,
  recordView,
  resolveShareToken,
} from "../../../lib/server/share";
import { MonthlyReportDoc } from "./MonthlyReportDoc";
import { ProposalDoc } from "./ProposalDoc";
import { ShareShell } from "./ShareShell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public link — never indexed (also enforced via X-Robots-Tag in middleware).
export const metadata: Metadata = {
  title: "Shared report",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Public, logged-out, READ-ONLY share surface (docs/phase8 §P8-REPORT). The
 * token in the path IS the capability. Unknown / revoked / expired tokens land
 * on a clean branded not-found with NO information leak. A valid token records
 * exactly one view, then renders the white-label artifact for its kind.
 */
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveShareToken(token);

  // Unknown / revoked / expired → branded 404 (not-found.tsx) with a 404 status,
  // so caches, crawlers and monitors don't treat a dead link as a live page.
  if (!resolved) notFound();

  // A valid open by a real client counts as one view. Link-preview crawlers
  // (WhatsApp/iMessage/Slack/Telegram/Discord unfurlers, social + search bots)
  // fire a GET the moment the agency PASTES the share URL into a message —
  // before the client has opened anything. They ignore the page's noindex
  // directives but announce themselves in the User-Agent, so exclude them; a
  // proposal's "viewed Nx" headline (P8-GROWTH2) must reflect real opens only.
  const userAgent = (await headers()).get("user-agent") ?? "";
  if (!isLinkUnfurler(userAgent)) await recordView(resolved.id);

  if (resolved.kind === "monthly_report") {
    const report = await loadSharedMonthlyReport(resolved);
    if (!report) return <BeingPrepared />;
    // P8-BENCH: anonymised industry benchmark for the SAME month as the report;
    // null (no industry / below the anonymity floor / no signal) hides the slot.
    const benchmark = resolved.clientId
      ? await loadClientBenchmark(resolved.orgId, resolved.clientId)
      : null;
    return <MonthlyReportDoc report={report} benchmark={benchmark} />;
  }

  // kind === "proposal" (docs/phase8/CONTRACTS.md §P8-GROWTH2): the
  // client-ready proposal document, reusing this shell.
  const proposal = await loadSharedProposal(resolved);
  if (!proposal) return <BeingPrepared />;
  return <ProposalDoc proposal={proposal} />;
}

/**
 * Known link-preview / crawler User-Agents whose GETs must NOT count as client
 * views. An empty UA is treated the same way: real browsers always send one, so
 * a blank UA is an automated fetch. This is deliberately broad — the cost of
 * missing a genuine view is far lower than systematically over-counting the
 * "viewed Nx" stat the growth loop is judged on.
 */
const UNFURLER_UA =
  /bot|crawl|spider|slurp|preview|unfurl|fetch|facebookexternalhit|whatsapp|telegram|discord|slack|skype|embedly|redditbot|applebot|bingbot|googlebot|linkedinbot|twitterbot|pinterest|vkshare|quora|w3c_validator|monitor|uptime|headless|curl|wget|python-requests|axios|node-fetch|go-http/i;

function isLinkUnfurler(userAgent: string): boolean {
  return userAgent.trim() === "" || UNFURLER_UA.test(userAgent);
}

/** Valid token, artifact not generated yet — gentle, still leak-free. */
function BeingPrepared() {
  return (
    <ShareShell agencyName="Report">
      <section
        className="card"
        style={{ padding: "40px 28px", display: "grid", gap: 10, textAlign: "center" }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 650, letterSpacing: "-0.01em" }}>
          Your report is being prepared
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.6 }}>
          Check back shortly — this page will show your latest report as soon as
          it&apos;s ready.
        </p>
      </section>
    </ShareShell>
  );
}
