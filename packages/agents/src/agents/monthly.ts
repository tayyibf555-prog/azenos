/**
 * The Monthly Strategist agent (spec §9.3; docs/phase5/CONTRACTS.md §P5-MONTHLY).
 *
 * runMonthlyStrategist builds the deterministic Agency Monthly data pack
 * (buildAgencyMonthlyPack), composes the versioned system prompt, runs it through
 * the fleet chassis (runAgent, agent 'monthly_strategist') ONCE, then fans the
 * single structured output out to THREE families of `briefs` rows (§9.3):
 *
 *   1. Owner monthly report — scope 'agency', period 'monthly', projectId null,
 *      with the MRR bridge, per-project ROI, portfolio health and strategy. It is
 *      DELIVERED (dryRun-able) via the Phase 3 deliverBrief.
 *   2. One per-client VALUE report per ACTIVE client — scope 'project', period
 *      'monthly', projectId = the client's representative project, and
 *      data_snapshot.clientId + data_snapshot.docType='client_value_report'.
 *      Stored as an internal draft (≥80% pasteable), NOT auto-sent.
 *   3. One upsell DOSSIER per ACTIVE client — same scoping with
 *      data_snapshot.docType='upsell_dossier'. Feeds Phase 6's Upsell Engine.
 *
 * Every brief persists data_snapshot = the pack slice the agent saw (auditable
 * AI, §13). Graceful degradation (§13): with no ANTHROPIC_API_KEY the runAgent
 * call returns a typed error and NO briefs are written (never a crash).
 *
 * @azen/agents has no drizzle-orm dependency, so conditional reads/updates go
 * through the postgres-js client (db.$client); inserts use db.insert(...).values,
 * matching the Daily Brief agent.
 */

import { randomUUID } from "node:crypto";
import { AGENT_MODEL } from "@azen/config";
import { type Db, briefs, db as defaultDb } from "@azen/db";
import type { DailyBriefEmailModel } from "@azen/emails";
import { z } from "zod";
import {
  type MonthlyClient,
  type MonthlyPack,
  buildAgencyMonthlyPack,
} from "../datapack/agency-monthly";
import {
  type BriefForDelivery,
  type DeliverBriefResult,
  type DeliverPrefs,
  deliverBrief,
} from "../delivery/deliver";
import { monthlyStrategistSystemPrompt } from "../prompts/monthly";
import { type AgentErrorCode, runAgent } from "../runner";

// ── output contract (docs/phase5/CONTRACTS.md §P5-MONTHLY — three documents) ──

export const monthlyOutputSchema = z.object({
  owner_report: z.object({
    headline: z.string(),
    summary_md: z.string(),
    portfolio_health_md: z.string(),
    roi_deep_dive_md: z.string(),
    mrr_bridge_md: z.string(),
    time_allocation_md: z.string(),
    recommendations: z.array(z.string()),
    whatsapp_text: z.string(),
  }),
  client_reports: z.array(
    z.object({
      clientId: z.string(),
      headline: z.string(),
      body_md: z.string(),
    }),
  ),
  upsell_dossiers: z.array(
    z.object({
      clientId: z.string(),
      headline: z.string(),
      opportunities: z.array(
        z.object({
          title: z.string(),
          rationale_md: z.string(),
          estimated_value_note: z.string(),
        }),
      ),
      summary_md: z.string(),
    }),
  ),
});

export type MonthlyOutput = z.infer<typeof monthlyOutputSchema>;
export type MonthlyOwnerReport = MonthlyOutput["owner_report"];
export type MonthlyClientReport = MonthlyOutput["client_reports"][number];
export type MonthlyUpsellDossier = MonthlyOutput["upsell_dossiers"][number];

const WHATSAPP_MAX_CHARS = 900;
/** cap the model's max tokens: three documents fan out from one call. */
const MONTHLY_MAX_TOKENS = 8000;

export interface RunMonthlyStrategistOptions {
  orgId: string;
  /** London calendar month to report (YYYY-MM); default = last complete month. */
  monthStart?: string;
  /** Attempt delivery of the OWNER report after generation. Default true. */
  deliver?: boolean;
  /** No network — deliverBrief returns the would-send payloads only. */
  dryRun?: boolean;
}

export interface MonthlyBriefRef {
  briefId: string;
  clientId: string;
  clientName: string;
  projectId: string;
}

export type RunMonthlyStrategistResult =
  | {
      ok: true;
      /** the owner monthly report brief id */
      ownerBriefId: string;
      clientReports: MonthlyBriefRef[];
      upsellDossiers: MonthlyBriefRef[];
      /** null when deliver===false (generation only). */
      delivered: DeliverBriefResult | null;
      forMonth: string;
      tokensIn: number;
      tokensOut: number;
    }
  | { ok: false; error: AgentErrorCode };

// ── generation ───────────────────────────────────────────────────────────────

export async function runMonthlyStrategist(
  db: Db,
  opts: RunMonthlyStrategistOptions,
): Promise<RunMonthlyStrategistResult> {
  const monthStartUTC = await resolveMonthStartUTC(db, opts.monthStart);
  const pack = await buildAgencyMonthlyPack(db, opts.orgId, monthStartUTC);

  const run = await runAgent<MonthlyOutput>({
    agent: "monthly_strategist",
    orgId: opts.orgId,
    systemPrompt: monthlyStrategistSystemPrompt(),
    userContent: JSON.stringify(pack),
    schema: monthlyOutputSchema,
    maxTokens: MONTHLY_MAX_TOKENS,
    dataSnapshot: pack as unknown as Record<string, unknown>,
  });

  // parse_failed / budget / provider errors surface WITHOUT half-written briefs.
  if (!run.ok) return { ok: false, error: run.error };
  const output = run.output;

  // Only active clients WITH a representative project are reportable — a
  // per-client brief needs a projectId to hang on (scope 'project').
  const reportable = new Map<string, MonthlyClient>();
  for (const c of pack.clients) {
    if (c.status === "active" && c.representativeProjectId) {
      reportable.set(c.clientId, c);
    }
  }

  // ── 1. owner monthly report (agency/monthly) ────────────────────────────────
  const ownerBriefId = randomUUID();
  const ownerWhatsapp = clampWhatsapp(output.owner_report.whatsapp_text);
  await db.insert(briefs).values({
    id: ownerBriefId,
    orgId: opts.orgId,
    scope: "agency",
    projectId: null,
    period: "monthly",
    periodStart: monthStartUTC,
    headline: output.owner_report.headline,
    bodyMd: composeOwnerBodyMd(output.owner_report),
    bodyWhatsapp: ownerWhatsapp,
    dataSnapshot: {
      docType: "owner_report",
      forMonth: pack.forMonth,
      pack: pack as unknown as Record<string, unknown>,
    },
    model: AGENT_MODEL,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    status: "generated",
  });

  // ── 2. per-client value reports (internal drafts, deduped by clientId) ──────
  const clientReports: MonthlyBriefRef[] = [];
  const seenReports = new Set<string>();
  for (const cr of output.client_reports) {
    const client = reportable.get(cr.clientId);
    if (!client || seenReports.has(cr.clientId)) continue;
    seenReports.add(cr.clientId);
    const briefId = randomUUID();
    await db.insert(briefs).values({
      id: briefId,
      orgId: opts.orgId,
      scope: "project",
      projectId: client.representativeProjectId,
      period: "monthly",
      periodStart: monthStartUTC,
      headline: cr.headline,
      bodyMd: composeClientBodyMd(cr, client),
      bodyWhatsapp: null,
      dataSnapshot: {
        docType: "client_value_report",
        clientId: client.clientId,
        clientName: client.clientName,
        forMonth: pack.forMonth,
        client: client as unknown as Record<string, unknown>,
      },
      model: AGENT_MODEL,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      status: "generated",
    });
    clientReports.push({
      briefId,
      clientId: client.clientId,
      clientName: client.clientName,
      projectId: client.representativeProjectId!,
    });
  }

  // ── 3. per-client upsell dossiers (feed Phase 6, deduped by clientId) ───────
  const upsellDossiers: MonthlyBriefRef[] = [];
  const seenDossiers = new Set<string>();
  for (const d of output.upsell_dossiers) {
    const client = reportable.get(d.clientId);
    if (!client || seenDossiers.has(d.clientId)) continue;
    seenDossiers.add(d.clientId);
    const briefId = randomUUID();
    await db.insert(briefs).values({
      id: briefId,
      orgId: opts.orgId,
      scope: "project",
      projectId: client.representativeProjectId,
      period: "monthly",
      periodStart: monthStartUTC,
      headline: d.headline,
      bodyMd: composeDossierBodyMd(d, client),
      bodyWhatsapp: null,
      dataSnapshot: {
        docType: "upsell_dossier",
        clientId: client.clientId,
        clientName: client.clientName,
        forMonth: pack.forMonth,
        opportunities: d.opportunities,
        seedInsights: client.topOpportunities as unknown as Record<string, unknown>[],
      },
      model: AGENT_MODEL,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      status: "generated",
    });
    upsellDossiers.push({
      briefId,
      clientId: client.clientId,
      clientName: client.clientName,
      projectId: client.representativeProjectId!,
    });
  }

  // ── deliver the OWNER report only (client drafts are never auto-sent) ───────
  let delivered: DeliverBriefResult | null = null;
  if (opts.deliver !== false) {
    const dryRun = opts.dryRun === true;
    const prefs = await resolveDeliverPrefs(db, opts.orgId);
    const brief: BriefForDelivery = {
      headline: output.owner_report.headline,
      emailModel: buildOwnerEmailModel(pack, output.owner_report),
      whatsappText: ownerWhatsapp,
    };
    delivered = await deliverBrief(brief, prefs, { dryRun });
    await stampDelivery(db, ownerBriefId, delivered, dryRun);
  }

  return {
    ok: true,
    ownerBriefId,
    clientReports,
    upsellDossiers,
    delivered,
    forMonth: pack.forMonth,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
  };
}

/** Convenience for the CLI / cron: run against the default pooled db. */
export function runMonthlyStrategistDefault(
  opts: RunMonthlyStrategistOptions,
): Promise<RunMonthlyStrategistResult> {
  return runMonthlyStrategist(defaultDb, opts);
}

// ── month boundary ─────────────────────────────────────────────────────────────

/**
 * The UTC instant of the START of the London month being reported — the SAME
 * instant the rollup engine writes for a month bucket's period_start (a naive
 * Date would be off by the BST offset and miss the equality join). A 'YYYY-MM'
 * arg reports that month; the default reports the LAST COMPLETE London month.
 */
async function resolveMonthStartUTC(db: Db, monthStart?: string): Promise<Date> {
  const client = db.$client;
  const rows = (monthStart
    ? await client`
        select to_char(
          ((${`${monthStart}-01`}::date)::timestamp at time zone 'Europe/London') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) as iso`
    : await client`
        select to_char(
          ((date_trunc('month', now() at time zone 'Europe/London') - interval '1 month')
            at time zone 'Europe/London') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) as iso`) as unknown as { iso: string }[];
  return new Date(rows[0]!.iso);
}

// ── delivery prefs (owner routing) — mirrors the Daily Brief resolver ─────────

interface OwnerRow {
  email: string | null;
  phone_whatsapp: string | null;
  notification_prefs: Record<string, unknown> | null;
}

const channelPrefSchema = z
  .object({
    enabled: z.boolean().optional(),
    to: z.string().nullable().optional(),
  })
  .optional();

const notificationPrefsSchema = z
  .object({
    email: channelPrefSchema,
    whatsapp: channelPrefSchema,
    sms: channelPrefSchema,
  })
  .catch({});

async function resolveDeliverPrefs(db: Db, orgId: string): Promise<DeliverPrefs> {
  const rows = (await db.$client`
    select email, phone_whatsapp, notification_prefs
    from users
    where org_id = ${orgId}::uuid
    order by (role = 'owner') desc, created_at asc
    limit 1
  `) as unknown as OwnerRow[];
  const owner = rows[0];
  const prefs = notificationPrefsSchema.parse(owner?.notification_prefs ?? {});
  const envWhatsapp = process.env.OWNER_WHATSAPP_TO || null;
  return {
    email: {
      enabled: prefs.email?.enabled,
      to: prefs.email?.to ?? owner?.email ?? null,
    },
    whatsapp: {
      enabled: prefs.whatsapp?.enabled,
      to: prefs.whatsapp?.to ?? owner?.phone_whatsapp ?? envWhatsapp,
    },
    sms: {
      enabled: prefs.sms?.enabled,
      to: prefs.sms?.to ?? owner?.phone_whatsapp ?? envWhatsapp,
    },
  };
}

/**
 * Stamp per-channel delivery status on the owner brief row. dryRun is a no-op:
 * nothing was sent, so sent* stay null and status stays 'generated'.
 */
async function stampDelivery(
  db: Db,
  briefId: string,
  result: DeliverBriefResult,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  const now = new Date().toISOString();
  const smsOk = result.sms?.ok ?? false;
  const emailAt = result.email.ok ? now : null;
  const whatsappAt = result.whatsapp.ok || smsOk ? now : null;
  const anyOk = result.email.ok || result.whatsapp.ok || smsOk;
  const status = anyOk ? "sent" : "failed";
  await db.$client`
    update briefs set
      sent_email_at = ${emailAt}::timestamptz,
      sent_whatsapp_at = ${whatsappAt}::timestamptz,
      status = ${status}::brief_status
    where id = ${briefId}::uuid
  `;
}

// ── body composition ────────────────────────────────────────────────────────────

function clampWhatsapp(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= WHATSAPP_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, WHATSAPP_MAX_CHARS - 1).trimEnd()}…`;
}

/** The full owner-report markdown persisted to briefs.bodyMd and rendered in UI. */
function composeOwnerBodyMd(o: MonthlyOwnerReport): string {
  const parts: string[] = [`# ${o.headline}`, "", o.summary_md.trim()];
  parts.push("", "## Portfolio health", o.portfolio_health_md.trim());
  parts.push("", "## ROI deep-dive", o.roi_deep_dive_md.trim());
  parts.push("", "## MRR bridge", o.mrr_bridge_md.trim());
  parts.push("", "## Where the month went", o.time_allocation_md.trim());
  if (o.recommendations.length > 0) {
    parts.push(
      "",
      "## Recommendations",
      ...o.recommendations.map((r) => `- ${r}`),
    );
  }
  return parts.join("\n");
}

/** The client value report markdown (external — the model's body, verbatim). */
function composeClientBodyMd(cr: MonthlyClientReport, _client: MonthlyClient): string {
  return [`# ${cr.headline}`, "", cr.body_md.trim()].join("\n");
}

/** The upsell dossier markdown (internal — opportunities + framing). */
function composeDossierBodyMd(
  d: MonthlyUpsellDossier,
  _client: MonthlyClient,
): string {
  const parts: string[] = [`# ${d.headline}`, "", d.summary_md.trim()];
  if (d.opportunities.length > 0) {
    parts.push("", "## Opportunities");
    for (const op of d.opportunities) {
      parts.push(
        "",
        `### ${op.title}`,
        op.rationale_md.trim(),
        "",
        `**Estimated value:** ${op.estimated_value_note}`,
      );
    }
  } else {
    parts.push("", "_No automation opportunities on file for this client yet._");
  }
  return parts.join("\n");
}

/**
 * Map the owner monthly report onto the (daily-shaped, but generic) brief email
 * model so the Phase 3 delivery layer can render it. Hero numbers come from the
 * pack; the body carries the owner summary; recommendations become the
 * "needs attention" block; the per-project table lists the month's projects.
 */
function buildOwnerEmailModel(
  pack: MonthlyPack,
  o: MonthlyOwnerReport,
): DailyBriefEmailModel {
  return {
    headline: o.headline,
    heroNumbers: {
      mrrPence: pack.agency.mrrPence,
      liveProjects: pack.agency.liveProjects,
      activeClients: pack.agency.activeClients,
      health: pack.agency.healthSummary,
    },
    agencySummaryMd: o.summary_md,
    needsAttention: o.recommendations,
    wins: [],
    projects: pack.projects.map((p) => ({
      name: p.name,
      clientName: p.clientName,
      health: p.health,
      revenueYesterdayPence: p.roi.revenueAttributedPence,
      minutesSavedYesterday: p.value.minutesSaved,
    })),
    dayLabel: pack.monthLabel,
  };
}
