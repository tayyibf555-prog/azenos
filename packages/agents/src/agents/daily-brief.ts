/**
 * The Daily Brief agent (spec §9.1, §9.7; docs/phase3/CONTRACTS.md §P3-BRIEF).
 *
 * runDailyBrief builds the deterministic Agency Daily data pack (the runner's
 * buildAgencyDailyPack), composes the versioned system prompt, runs it through
 * the fleet chassis as a CRITICAL run (the daily brief always runs, §13),
 * persists a `briefs` row with its data_snapshot (auditable AI — every number
 * the agent saw), then delivers via the P3-DELIVERY orchestrator unless
 * deliver===false. resendBrief re-delivers a stored brief.
 *
 * @azen/agents has no drizzle-orm dependency, so conditional reads/updates go
 * through the postgres-js client (db.$client); inserts use db.insert(...).values
 * (no operators needed), matching the runner.
 */

import { randomUUID } from "node:crypto";
import { AGENT_MODEL } from "@azen/config";
import { type Db, briefs, db as defaultDb } from "@azen/db";
import type {
  BriefProjectRow,
  DailyBriefEmailModel,
} from "@azen/emails";
import { z } from "zod";
import { buildAgencyDailyPack } from "../datapack/agency-daily";
import type { DailyPack } from "../datapack/types";
import {
  type BriefForDelivery,
  type DeliverBriefResult,
  type DeliverPrefs,
  deliverBrief,
} from "../delivery/deliver";
import { dailyBriefSystemPrompt } from "../prompts/daily-brief";
import { type AgentErrorCode, runAgent } from "../runner";

// ── output contract (spec §9.1 exact) ────────────────────────────────────────
// whatsapp_text has NO max in the schema on purpose: a length constraint that
// the model overshoots would fail structured-output parsing and, after the
// single retry, sink a CRITICAL run. Instead the prompt states the 900-char
// limit and runDailyBrief CLAMPS defensively (belt and braces).
export const dailyBriefOutputSchema = z.object({
  headline: z.string(),
  agency_summary_md: z.string(),
  projects: z.array(
    z.object({
      project_id: z.string().optional(),
      name: z.string(),
      paragraph_md: z.string(),
      collapsed: z.boolean().optional(),
    }),
  ),
  needs_attention: z.array(z.string()),
  wins: z.array(z.string()),
  whatsapp_text: z.string(),
});

export type DailyBriefOutput = z.infer<typeof dailyBriefOutputSchema>;

const WHATSAPP_MAX_CHARS = 900;

export interface RunDailyBriefOptions {
  orgId: string;
  /** London calendar day to summarise (YYYY-MM-DD); default = yesterday. */
  forDay?: string;
  /** Attempt delivery after generation. Default true. */
  deliver?: boolean;
  /** No network — deliverBrief returns the would-send payloads only. */
  dryRun?: boolean;
}

export type RunDailyBriefResult =
  | {
      ok: true;
      briefId: string;
      /** null when deliver===false (generation only). */
      delivered: DeliverBriefResult | null;
      tokensIn: number;
      tokensOut: number;
    }
  | { ok: false; error: AgentErrorCode };

export interface ResendBriefOptions {
  orgId: string;
  briefId: string;
  dryRun?: boolean;
}

export type ResendBriefResult =
  | { ok: true; delivered: DeliverBriefResult }
  | { ok: false; error: "brief_not_found" };

// ── generation ───────────────────────────────────────────────────────────────

export async function runDailyBrief(
  db: Db,
  opts: RunDailyBriefOptions,
): Promise<RunDailyBriefResult> {
  const forDayStart = await resolveForDayStartUTC(db, opts.forDay);
  const pack = await buildAgencyDailyPack(db, opts.orgId, forDayStart);

  const run = await runAgent<DailyBriefOutput>({
    agent: "daily_brief",
    orgId: opts.orgId,
    systemPrompt: dailyBriefSystemPrompt(),
    userContent: JSON.stringify(pack),
    schema: dailyBriefOutputSchema,
    // §13: the daily brief always runs, even past the monthly budget cap.
    critical: true,
    dataSnapshot: pack as unknown as Record<string, unknown>,
  });

  // parse_failed / budget / provider errors surface WITHOUT a half-written brief.
  if (!run.ok) return { ok: false, error: run.error };

  const output = run.output;
  const whatsapp = clampWhatsapp(output.whatsapp_text);
  const briefId = randomUUID();

  await db.insert(briefs).values({
    id: briefId,
    orgId: opts.orgId,
    scope: "agency",
    projectId: null,
    period: "daily",
    periodStart: forDayStart,
    headline: output.headline,
    bodyMd: composeBodyMd(output),
    bodyWhatsapp: whatsapp,
    dataSnapshot: pack as unknown as Record<string, unknown>,
    model: AGENT_MODEL,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    status: "generated",
  });

  if (opts.deliver === false) {
    return {
      ok: true,
      briefId,
      delivered: null,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
    };
  }

  const dryRun = opts.dryRun === true;
  const emailModel = buildEmailModel(pack, output);
  const prefs = await resolveDeliverPrefs(db, opts.orgId);
  const delivered = await deliverBrief(
    { headline: output.headline, emailModel, whatsappText: whatsapp },
    prefs,
    { dryRun },
  );
  await stampDelivery(db, briefId, delivered, dryRun);

  return {
    ok: true,
    briefId,
    delivered,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
  };
}

// ── resend a stored brief ─────────────────────────────────────────────────────

export async function resendBrief(
  db: Db,
  opts: ResendBriefOptions,
): Promise<ResendBriefResult> {
  const rows = (await db.$client`
    select id::text as id, headline, body_md, body_whatsapp, data_snapshot
    from briefs
    where id = ${opts.briefId}::uuid and org_id = ${opts.orgId}::uuid
    limit 1
  `) as unknown as StoredBriefRow[];
  const row = rows[0];
  if (!row) return { ok: false, error: "brief_not_found" };

  const pack = (row.data_snapshot ?? {}) as Partial<DailyPack>;
  const dryRun = opts.dryRun === true;
  const brief: BriefForDelivery = {
    headline: row.headline,
    emailModel: rebuildEmailModel(row, pack),
    whatsappText: clampWhatsapp(row.body_whatsapp ?? row.headline),
  };
  const prefs = await resolveDeliverPrefs(db, opts.orgId);
  const delivered = await deliverBrief(brief, prefs, { dryRun });
  await stampDelivery(db, opts.briefId, delivered, dryRun);
  return { ok: true, delivered };
}

// ── data-pack day boundary ────────────────────────────────────────────────────

/**
 * The UTC instant of the START of the London day being summarised. Computed in
 * Postgres so it lands on the SAME instant the rollup engine used for
 * metric_rollups.period_start (a naive `new Date("…T00:00:00Z")` would be off
 * by the BST offset and miss the rollup equality join). Default = yesterday.
 */
async function resolveForDayStartUTC(db: Db, forDay?: string): Promise<Date> {
  const client = db.$client;
  const rows = (forDay
    ? await client`
        select to_char(
          (${forDay}::timestamp at time zone 'Europe/London') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) as iso`
    : await client`
        select to_char(
          ((date_trunc('day', now() at time zone 'Europe/London') - interval '1 day')
            at time zone 'Europe/London') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) as iso`) as unknown as { iso: string }[];
  return new Date(rows[0]!.iso);
}

// ── delivery prefs ─────────────────────────────────────────────────────────────

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

/**
 * Resolve per-channel routing from the org owner's users.notificationPrefs,
 * falling back to the owner's email / WhatsApp number and OWNER_WHATSAPP_TO env.
 * Absent recipients are left empty — deliverBrief then reports a typed
 * no-recipient reason instead of throwing (graceful degradation without keys).
 */
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

// ── delivery stamping ──────────────────────────────────────────────────────────

/**
 * Stamp per-channel delivery status on the brief row. dryRun is a no-op: nothing
 * was actually sent, so sent* stay null and status stays 'generated'.
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
  // WhatsApp and its SMS fallback are the one "mobile" channel on the schema.
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

// ── model → email/body shaping ─────────────────────────────────────────────────

interface StoredBriefRow {
  id: string;
  headline: string;
  body_md: string;
  body_whatsapp: string | null;
  data_snapshot: Record<string, unknown> | null;
}

function clampWhatsapp(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= WHATSAPP_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, WHATSAPP_MAX_CHARS - 1).trimEnd()}…`;
}

function firstLine(md: string): string {
  const line = md.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.replace(/^#+\s*/, "").trim();
}

/** Full markdown document persisted to briefs.bodyMd and rendered in the UI. */
function composeBodyMd(o: DailyBriefOutput): string {
  const parts: string[] = [`# ${o.headline}`, "", o.agency_summary_md.trim()];

  if (o.needs_attention.length > 0) {
    parts.push("", "## Needs attention", ...o.needs_attention.map((x) => `- ${x}`));
  }
  if (o.wins.length > 0) {
    parts.push("", "## Wins", ...o.wins.map((x) => `- ${x}`));
  }

  const written = o.projects.filter((p) => p.collapsed !== true);
  const quiet = o.projects.filter((p) => p.collapsed === true);
  if (written.length > 0) {
    parts.push("", "## Projects");
    for (const p of written) {
      parts.push("", `### ${p.name}`, p.paragraph_md.trim());
    }
  }
  if (quiet.length > 0) {
    parts.push("", "## Quiet projects");
    for (const p of quiet) {
      parts.push(`- **${p.name}** — ${p.paragraph_md.trim()}`);
    }
  }
  return parts.join("\n");
}

function buildProjectRows(
  pack: DailyPack,
  o: DailyBriefOutput,
): BriefProjectRow[] {
  const byId = new Map<string, DailyBriefOutput["projects"][number]>();
  const byName = new Map<string, DailyBriefOutput["projects"][number]>();
  for (const p of o.projects) {
    if (p.project_id) byId.set(p.project_id, p);
    byName.set(p.name.toLowerCase(), p);
  }
  return pack.projects.map((pp) => {
    const match =
      (pp.id ? byId.get(pp.id) : undefined) ?? byName.get(pp.name.toLowerCase());
    return {
      name: pp.name,
      clientName: pp.clientName,
      health: pp.health,
      summary: match ? firstLine(match.paragraph_md) : undefined,
      revenueYesterdayPence: pp.revenueYesterdayPence,
      minutesSavedYesterday: pp.minutesSavedYesterday,
    };
  });
}

function buildEmailModel(
  pack: DailyPack,
  o: DailyBriefOutput,
): DailyBriefEmailModel {
  return {
    headline: o.headline,
    heroNumbers: {
      mrrPence: pack.agency.mrrPence,
      liveProjects: pack.agency.liveProjects,
      activeClients: pack.agency.activeClients,
      health: pack.agency.healthSummary,
    },
    agencySummaryMd: o.agency_summary_md,
    needsAttention: o.needs_attention,
    wins: o.wins,
    projects: buildProjectRows(pack, o),
    dayLabel: londonDayLabel(pack.forDay),
  };
}

/**
 * Rebuild an email model for a RE-SEND from the stored pack + text columns. The
 * structured needs/wins/paragraphs are not persisted separately (only headline/
 * bodyMd/bodyWhatsapp/dataSnapshot columns exist), so the resent email carries
 * the full narrative in the summary block and the project table from the pack —
 * faithful in numbers, if flatter than the original.
 */
function rebuildEmailModel(
  row: StoredBriefRow,
  pack: Partial<DailyPack>,
): DailyBriefEmailModel {
  const agency = pack.agency;
  return {
    headline: row.headline,
    heroNumbers: {
      mrrPence: agency?.mrrPence ?? 0,
      liveProjects: agency?.liveProjects ?? 0,
      activeClients: agency?.activeClients ?? 0,
      health: agency?.healthSummary ?? { green: 0, amber: 0, red: 0 },
    },
    agencySummaryMd: row.body_md,
    needsAttention: [],
    wins: [],
    projects: (pack.projects ?? []).map((pp) => ({
      name: pp.name,
      clientName: pp.clientName,
      health: pp.health,
      revenueYesterdayPence: pp.revenueYesterdayPence,
      minutesSavedYesterday: pp.minutesSavedYesterday,
    })),
    dayLabel: pack.forDay ? londonDayLabel(pack.forDay) : undefined,
  };
}

/** "YYYY-MM-DD" London day → "Sat 12 Jul 2026". */
function londonDayLabel(forDay: string): string {
  const at = new Date(`${forDay}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return forDay;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
}

/** Convenience for the CLI / cron: run against the default pooled db. */
export function runDailyBriefDefault(
  opts: RunDailyBriefOptions,
): Promise<RunDailyBriefResult> {
  return runDailyBrief(defaultDb, opts);
}
