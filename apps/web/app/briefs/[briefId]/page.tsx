import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { briefs, db } from "@azen/db";
import { CollapsibleSnapshot } from "../../../components/CollapsibleSnapshot";
import { DeliveryChips } from "../../../components/DeliveryChips";
import { Markdown } from "../../../components/Markdown";
import { PageHeader } from "../../../components/PageHeader";
import { ResendBriefButton } from "../../../components/ResendBriefButton";
import { COLORS, tint } from "../../../components/ui";
import type { BriefPeriod, BriefStatus } from "../../../components/brief-types";
import { formatLondonDate, formatLondonTime } from "../../../lib/format";
import { requireOrgId } from "../../../lib/server/org";

export const dynamic = "force-dynamic";

const PERIOD_COLOR: Record<string, string> = {
  daily: COLORS.blue,
  weekly: COLORS.violet,
  monthly: COLORS.teal,
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
  const pColor = PERIOD_COLOR[period] ?? COLORS.grey;

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
            <span
              className="badge"
              style={{
                color: pColor,
                background: tint(pColor, 0.12),
                borderColor: tint(pColor, 0.28),
              }}
            >
              {period}
            </span>
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
            <span className="faint mono" style={{ fontSize: 11.5 }}>
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

        {row.bodyWhatsapp && (
          <section className="card" style={{ padding: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "13px 18px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span
                className="dot"
                style={{ width: 7, height: 7, background: COLORS.green }}
                aria-hidden
              />
              <h3 style={{ fontSize: 13.5 }}>WhatsApp message</h3>
              <span className="faint" style={{ fontSize: 11.5 }}>
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
