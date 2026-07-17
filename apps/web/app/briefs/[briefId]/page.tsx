import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { briefs, db } from "@azen/db";
import { CollapsibleSnapshot } from "../../../components/CollapsibleSnapshot";
import { DeliveryChips } from "../../../components/DeliveryChips";
import { Markdown } from "../../../components/Markdown";
import { PageHeader } from "../../../components/PageHeader";
import { ResendBriefButton } from "../../../components/ResendBriefButton";
import { ShareReportPanel } from "../../../components/ShareReportPanel";
import { Pill } from "../../../components/system/Pill";
import type { SquircleTone } from "../../../components/system/tokens";
import type { BriefPeriod, BriefStatus } from "../../../components/brief-types";
import { formatLondonDate, formatLondonTime } from "../../../lib/format";
import { requireOrgId } from "../../../lib/server/org";
import { listMonthlyReportTokens } from "../../../lib/server/share";

export const dynamic = "force-dynamic";

/** RECIPE §3 tinted pill per brief cadence — no bespoke colour, category tone only. */
const PERIOD_TONE: Record<string, SquircleTone> = {
  daily: "sky",
  weekly: "lavender",
  monthly: "butter",
};

export default async function BriefDetailPage({
  params,
}: {
  params: Promise<{ briefId: string }>;
}) {
  const { briefId } = await params;

  let orgId: string;
  try {
    orgId = await requireOrgId();
  } catch {
    return (
      <div className="card" style={{ padding: 20 }}>
        <strong>Sign in required.</strong>
      </div>
    );
  }

  const row = await db.query.briefs.findFirst({
    where: and(eq(briefs.id, briefId), eq(briefs.orgId, orgId)),
  });
  if (!row) notFound();

  const period = row.period as BriefPeriod;
  const status = row.status as BriefStatus;

  // Monthly per-client value reports are shareable as a public white-label link.
  const snapshot = row.dataSnapshot as Record<string, unknown> | null;
  const shareClientId =
    period === "monthly" && snapshot?.["docType"] === "client_value_report"
      ? typeof snapshot["clientId"] === "string"
        ? (snapshot["clientId"] as string)
        : null
      : null;
  const shareTokens = shareClientId
    ? await listMonthlyReportTokens(orgId, shareClientId)
    : [];

  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{ marginBottom: 18 }}>
        <Link href="/briefs" className="btn btn-ghost btn-sm">
          ← All briefs
        </Link>
      </div>

      <PageHeader
        title={row.headline}
        subtitle={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Pill tone={PERIOD_TONE[period] ?? "graphite"}>{period}</Pill>
            {row.scope} · {formatLondonDate(row.periodStart)} · generated{" "}
            {formatLondonTime(row.createdAt)}
          </span>
        }
        actions={<ResendBriefButton briefId={row.id} />}
      />

      <div style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <DeliveryChips
            status={status}
            sentEmailAt={row.sentEmailAt ? row.sentEmailAt.toISOString() : null}
            sentWhatsappAt={row.sentWhatsappAt ? row.sentWhatsappAt.toISOString() : null}
          />
          {row.model && (
            <span className="faint mono tnum" style={{ fontSize: 11.5 }}>
              {row.model}
              {row.tokensIn != null && row.tokensOut != null
                ? ` · ${row.tokensIn}→${row.tokensOut} tok`
                : ""}
            </span>
          )}
        </div>

        <section className="card" style={{ padding: "20px 22px" }}>
          <Markdown source={row.bodyMd} />
        </section>

        {shareClientId && (
          <ShareReportPanel
            clientId={shareClientId}
            initialTokens={shareTokens}
          />
        )}

        {row.bodyWhatsapp && (
          <section className="card" style={{ padding: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "13px 18px",
                borderRadius: "var(--radius-card) var(--radius-card) 0 0",
                background: "var(--bg-well)",
              }}
            >
              <span
                className="dot"
                style={{ width: 7, height: 7, background: "var(--green)" }}
                aria-hidden
              />
              <h3 style={{ fontSize: 13.5, fontWeight: 620 }}>WhatsApp message</h3>
              <span className="faint tnum" style={{ fontSize: 11.5 }}>
                {row.bodyWhatsapp.length}/900 chars
              </span>
            </div>
            <p
              style={{
                padding: "16px 18px",
                fontSize: 13.5,
                lineHeight: 1.6,
                color: "var(--text)",
                whiteSpace: "pre-wrap",
              }}
            >
              {row.bodyWhatsapp}
            </p>
          </section>
        )}

        <CollapsibleSnapshot value={row.dataSnapshot} />
      </div>
    </div>
  );
}
