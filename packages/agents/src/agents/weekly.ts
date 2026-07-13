/**
 * The Weekly Synthesizer agent (spec §9.2; docs/phase5/CONTRACTS.md §P5-WEEKLY).
 *
 * runWeeklySynth resolves the London week to summarise, builds the deterministic
 * Agency Weekly data pack (buildAgencyWeeklyPack — which also folds in the prior
 * weekly edition so the agent can reference what changed), runs it through the
 * fleet chassis (runAgent, agent 'weekly_synth', NON-critical — the weekly synth
 * respects the monthly budget halt, unlike the always-on daily brief), persists
 * a `briefs` row (period 'weekly') with its data_snapshot, then delivers via the
 * Phase 3 deliverBrief unless deliver===false. dryRun returns the would-send
 * payloads with no network.
 *
 * Graceful degradation (spec §13): with no ANTHROPIC_API_KEY the runAgent call
 * returns a typed error and NO brief is written (never a crash).
 *
 * @azen/agents has no drizzle-orm dependency, so conditional reads/updates go
 * through the postgres-js client (db.$client); inserts use db.insert(...).values,
 * matching the Daily Brief agent.
 */

import { randomUUID } from "node:crypto";
import { AGENT_MODEL } from "@azen/config";
import { type Db, briefs, db as defaultDb } from "@azen/db";
import type { BriefProjectRow, DailyBriefEmailModel } from "@azen/emails";
import { z } from "zod";
import {
  type WeeklyPack,
  buildAgencyWeeklyPack,
} from "../datapack/agency-weekly";
import {
  type BriefForDelivery,
  type DeliverBriefResult,
  type DeliverPrefs,
  deliverBrief,
} from "../delivery/deliver";
import { weeklySynthSystemPrompt } from "../prompts/weekly";
import { type AgentErrorCode, runAgent } from "../runner";

// ── output contract (spec §9.2 exact) ─────────────────────────────────────────
// No length constraints in the schema (a length the model overshoots would fail
// structured-output parsing); the prompt states the limits and runWeeklySynth
// CLAMPS/normalises defensively.
export const weeklyOutputSchema = z.object({
  headline: z.string(),
  agency_narrative_md: z.string(),
  projects: z.array(
    z.object({
      name: z.string(),
      wow_narrative_md: z.string(),
    }),
  ),
  scoreboard: z.array(
    z.object({
      kpi: z.string(),
      this_week: z.number(),
      last_week: z.number(),
      four_wk_avg: z.number(),
      trend: z.string(),
    }),
  ),
  top_priorities: z.array(z.string()),
  whatsapp_text: z.string(),
});

export type WeeklyOutput = z.infer<typeof weeklyOutputSchema>;

const WHATSAPP_MAX_CHARS = 900;

export interface RunWeeklySynthOptions {
  orgId: string;
  /**
   * London Monday (YYYY-MM-DD) that starts the week to summarise. Any day works
   * — it is snapped to that week's Monday. Default = the most recent COMPLETE
   * week (last Monday–Sunday).
   */
  weekStart?: string;
  /** Attempt delivery after generation. Default true. */
  deliver?: boolean;
  /** No network — deliverBrief returns the would-send payloads only. */
  dryRun?: boolean;
}

export type RunWeeklySynthResult =
  | {
      ok: true;
      briefId: string;
      weekStart: string;
      weekEnd: string;
      /** null when deliver===false (generation only). */
      delivered: DeliverBriefResult | null;
      /** true when the pack carried a prior weekly edition the agent referenced. */
      referencedPriorEdition: boolean;
      tokensIn: number;
      tokensOut: number;
    }
  | { ok: false; error: AgentErrorCode };

// ── generation ────────────────────────────────────────────────────────────────

export async function runWeeklySynth(
  db: Db,
  opts: RunWeeklySynthOptions,
): Promise<RunWeeklySynthResult> {
  const weekStartUTC = await resolveWeekStartUTC(db, opts.weekStart);
  const pack = await buildAgencyWeeklyPack(db, opts.orgId, weekStartUTC);

  const run = await runAgent<WeeklyOutput>({
    agent: "weekly_synth",
    orgId: opts.orgId,
    systemPrompt: weeklySynthSystemPrompt(),
    userContent: JSON.stringify(pack),
    schema: weeklyOutputSchema,
    // §13: the weekly synth is NOT critical — it respects the monthly budget halt.
    critical: false,
    dataSnapshot: pack as unknown as Record<string, unknown>,
    maxTokens: 4000,
  });

  if (!run.ok) return { ok: false, error: run.error };

  const output = run.output;
  const whatsapp = clampWhatsapp(output.whatsapp_text);
  const briefId = randomUUID();

  await db.insert(briefs).values({
    id: briefId,
    orgId: opts.orgId,
    scope: "agency",
    projectId: null,
    period: "weekly",
    periodStart: weekStartUTC,
    headline: output.headline,
    bodyMd: composeBodyMd(pack, output),
    bodyWhatsapp: whatsapp,
    dataSnapshot: pack as unknown as Record<string, unknown>,
    model: AGENT_MODEL,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    status: "generated",
  });

  const referencedPriorEdition = pack.priorEdition !== null;

  if (opts.deliver === false) {
    return {
      ok: true,
      briefId,
      weekStart: pack.weekStart,
      weekEnd: pack.weekEnd,
      delivered: null,
      referencedPriorEdition,
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
    weekStart: pack.weekStart,
    weekEnd: pack.weekEnd,
    delivered,
    referencedPriorEdition,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
  };
}

/** Convenience for the CLI / cron: run against the default pooled db. */
export function runWeeklySynthDefault(
  opts: RunWeeklySynthOptions,
): Promise<RunWeeklySynthResult> {
  return runWeeklySynth(defaultDb, opts);
}

// ── week boundary ──────────────────────────────────────────────────────────────

/**
 * The UTC instant of the START of the London week (Monday 00:00 London) to
 * summarise. Computed in Postgres (date_trunc('week') is ISO-Monday) so it lands
 * on the SAME instant the rollup engine used for week buckets. Default = the
 * most recent COMPLETE week: the Monday of LAST week.
 */
async function resolveWeekStartUTC(db: Db, weekStart?: string): Promise<Date> {
  const client = db.$client;
  const rows = (weekStart
    ? await client`
        select to_char(
          (date_trunc('week', ${weekStart}::timestamp) at time zone 'Europe/London') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) as iso`
    : await client`
        select to_char(
          ((date_trunc('week', now() at time zone 'Europe/London') - interval '7 days')
            at time zone 'Europe/London') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) as iso`) as unknown as { iso: string }[];
  return new Date(rows[0]!.iso);
}

// ── delivery prefs (mirrors the Daily Brief agent) ─────────────────────────────

interface OwnerRow {
  email: string | null;
  phone_whatsapp: string | null;
  notification_prefs: Record<string, unknown> | null;
}

const channelPrefSchema = z
  .object({ enabled: z.boolean().optional(), to: z.string().nullable().optional() })
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
    email: { enabled: prefs.email?.enabled, to: prefs.email?.to ?? owner?.email ?? null },
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

// ── model → email/body shaping ─────────────────────────────────────────────────

function clampWhatsapp(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= WHATSAPP_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, WHATSAPP_MAX_CHARS - 1).trimEnd()}…`;
}

function firstLine(md: string): string {
  const line = md.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.replace(/^#+\s*/, "").trim();
}

/** £ from integer pence, deterministic (no locale separators). */
function gbp(pence: number): string {
  const negative = pence < 0;
  const abs = Math.abs(Math.round(pence));
  return `${negative ? "-" : ""}£${(abs / 100).toFixed(2)}`;
}

/** Format a scoreboard value for the body: pence → £, else the plain integer. */
function scoreboardValue(unit: string, value: number): string {
  return unit === "pence" ? gbp(value) : String(Math.round(value));
}

/** Full markdown document persisted to briefs.bodyMd and rendered in the UI. */
function composeBodyMd(pack: WeeklyPack, o: WeeklyOutput): string {
  const parts: string[] = [
    `# ${o.headline}`,
    "",
    `Week of ${pack.weekStart} – ${pack.weekEnd}`,
    "",
    o.agency_narrative_md.trim(),
  ];

  if (o.scoreboard.length > 0) {
    // Pair each output row with the pack's unit for £ formatting.
    const unitByName = new Map(pack.scoreboard.map((s) => [s.name, s.unit] as const));
    parts.push("", "## Scoreboard");
    for (const row of o.scoreboard) {
      const unit = unitByName.get(row.kpi) ?? "count";
      const tw = scoreboardValue(unit, row.this_week);
      const lw = scoreboardValue(unit, row.last_week);
      const avg = scoreboardValue(unit, row.four_wk_avg);
      parts.push(
        `- **${row.kpi}**: ${tw} (last week ${lw}, 4-wk avg ${avg}) — ${row.trend}`,
      );
    }
  }

  if (o.top_priorities.length > 0) {
    parts.push("", "## Top priorities");
    o.top_priorities.forEach((p, i) => parts.push(`${i + 1}. ${p}`));
  }

  if (o.projects.length > 0) {
    parts.push("", "## Projects");
    for (const p of o.projects) {
      parts.push("", `### ${p.name}`, p.wow_narrative_md.trim());
    }
  }
  return parts.join("\n");
}

function buildProjectRows(pack: WeeklyPack, o: WeeklyOutput): BriefProjectRow[] {
  const byName = new Map(o.projects.map((p) => [p.name.toLowerCase(), p]));
  return pack.projects.map((pp) => {
    const match = byName.get(pp.name.toLowerCase());
    return {
      name: pp.name,
      clientName: pp.clientName,
      health: pp.health,
      summary: match ? firstLine(match.wow_narrative_md) : undefined,
      revenueYesterdayPence: pp.revenuePence,
      minutesSavedYesterday: pp.minutesSaved,
    };
  });
}

function buildEmailModel(pack: WeeklyPack, o: WeeklyOutput): DailyBriefEmailModel {
  return {
    headline: o.headline,
    heroNumbers: {
      mrrPence: pack.agency.mrrPence,
      liveProjects: pack.agency.liveProjects,
      activeClients: pack.agency.activeClients,
      health: pack.agency.healthSummary,
    },
    agencySummaryMd: o.agency_narrative_md,
    // The weekly brief reuses the Daily Brief email template: top priorities map
    // to the "needs attention" block; wins are folded into the narrative.
    needsAttention: o.top_priorities,
    wins: [],
    projects: buildProjectRows(pack, o),
    dayLabel: `Week of ${pack.weekStart} – ${pack.weekEnd}`,
  };
}
