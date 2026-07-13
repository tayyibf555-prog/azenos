import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, events, insights } from "@azen/db";
import { z } from "zod";

/**
 * P5-CONVO — the Conversations tab data source (docs/phase5/CONTRACTS.md).
 * Two halves, both org-scoped:
 *  - `topics`: the faq_cluster insights the clustering agent wrote for this
 *    project (latest computed state; NOT window-bound), each resolved with its
 *    example `llm.conversation` events for the drill-down.
 *  - resolution / escalation rates, a daily volume series, and the sentiment mix
 *    — pure SQL over the `llm.conversation` events inside an inclusive [from,to]
 *    window of London calendar days, resolved to UTC instants in Postgres with
 *    the shared `… at time zone 'Europe/London'` pattern (DST-correct).
 * No LLM here — clustering is the agent's job; this route only reads.
 */

/** from/to are inclusive London calendar days (YYYY-MM-DD); both optional. */
export const conversationsQuerySchema = z.object({
  from: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.iso.date().optional(),
  ),
  to: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.iso.date().optional(),
  ),
});
export type ConversationsQuery = z.infer<typeof conversationsQuerySchema>;

export interface ConversationExample {
  eventId: string;
  occurredAt: string;
  channel: string | null;
  intent: string | null;
  resolution: string | null;
  sentiment: string | null;
  summary: string | null;
}

export interface TopicCluster {
  id: string;
  title: string;
  bodyMd: string;
  confidence: string;
  status: string;
  createdAt: string;
  count: number;
  sharePct: number;
  /** 'up' | 'down' | 'flat' | 'new' | '' when the agent left it unset. */
  trend: string;
  scoutCandidate: boolean;
  exampleEventIds: string[];
  examples: ConversationExample[];
}

export interface ConversationsResponse {
  from: string;
  to: string;
  totalConversations: number;
  resolution: {
    resolved: number;
    escalated: number;
    abandoned: number;
    total: number;
  };
  /** resolved ÷ total, 0..1; null when there are no conversations. */
  resolutionRate: number | null;
  /** escalated ÷ total, 0..1; null when there are no conversations. */
  escalationRate: number | null;
  volumeSeries: { periodStart: string; value: number }[];
  sentimentMix: { positive: number; neutral: number; negative: number };
  topics: TopicCluster[];
}

const num = (v: unknown): number => Number(v ?? 0);
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

interface CountsRow {
  total: number | string;
  resolved: number | string;
  escalated: number | string;
  abandoned: number | string;
  positive: number | string;
  neutral: number | string;
  negative: number | string;
  from_s: string;
  to_s: string;
}

interface VolumeRow {
  period_start: string;
  value: number | string;
}

interface InsightRow {
  id: string;
  title: string;
  bodyMd: string;
  evidence: Record<string, unknown>;
  confidence: string;
  status: string;
  createdAt: Date;
}

function evidenceIds(evidence: Record<string, unknown>): string[] {
  const ids = evidence["event_ids"];
  if (!Array.isArray(ids)) return [];
  return ids.filter((v): v is string => typeof v === "string");
}

export async function getProjectConversations(
  orgId: string,
  projectId: string,
  query: ConversationsQuery,
): Promise<ConversationsResponse> {
  const from = query.from ?? null;
  const to = query.to ?? null;

  // ── window counts (resolution + sentiment mix + total) ──────────────────────
  const countRows = (await db.execute(sql`
    with bounds as (
      select
        coalesce(${from}::date, (now() at time zone 'Europe/London')::date - interval '29 days')::date as from_d,
        coalesce(${to}::date, (now() at time zone 'Europe/London')::date)::date as to_d
    ),
    win as (
      select
        (from_d::timestamp at time zone 'Europe/London') as w_start,
        ((to_d + 1)::timestamp at time zone 'Europe/London') as w_end,
        to_char(from_d, 'YYYY-MM-DD') as from_s,
        to_char(to_d, 'YYYY-MM-DD') as to_s
      from bounds
    ),
    ev as (
      select e.data
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.type = 'llm.conversation'
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
    )
    select
      (select count(*) from ev)::int as total,
      (select count(*) from ev where data->>'resolution' = 'resolved')::int as resolved,
      (select count(*) from ev where data->>'resolution' = 'escalated')::int as escalated,
      (select count(*) from ev where data->>'resolution' = 'abandoned')::int as abandoned,
      (select count(*) from ev where data->>'sentiment' = 'positive')::int as positive,
      (select count(*) from ev where data->>'sentiment' = 'neutral')::int as neutral,
      (select count(*) from ev where data->>'sentiment' = 'negative')::int as negative,
      (select from_s from win) as from_s,
      (select to_s from win) as to_s
  `)) as unknown as CountsRow[];
  const c = countRows[0]!;
  const total = num(c.total);
  const resolved = num(c.resolved);
  const escalated = num(c.escalated);

  // ── daily volume series (London day buckets, ascending; present days only) ──
  const volumeRows = (await db.execute(sql`
    with bounds as (
      select
        coalesce(${from}::date, (now() at time zone 'Europe/London')::date - interval '29 days')::date as from_d,
        coalesce(${to}::date, (now() at time zone 'Europe/London')::date)::date as to_d
    ),
    win as (
      select
        (from_d::timestamp at time zone 'Europe/London') as w_start,
        ((to_d + 1)::timestamp at time zone 'Europe/London') as w_end
      from bounds
    )
    select
      to_char(
        (date_trunc('day', e.occurred_at at time zone 'Europe/London') at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      ) as period_start,
      count(*)::int as value
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.type = 'llm.conversation'
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    group by 1
    order by 1
  `)) as unknown as VolumeRow[];

  // ── faq_cluster insights (latest state, not dismissed) ──────────────────────
  const insightRows = (await db
    .select({
      id: insights.id,
      title: insights.title,
      bodyMd: insights.bodyMd,
      evidence: insights.evidence,
      confidence: insights.confidence,
      status: insights.status,
      createdAt: insights.createdAt,
    })
    .from(insights)
    .where(
      and(
        eq(insights.orgId, orgId),
        eq(insights.projectId, projectId),
        eq(insights.kind, "faq_cluster"),
        ne(insights.status, "dismissed"),
      ),
    )
    .orderBy(desc(insights.createdAt))) as unknown as InsightRow[];

  // Resolve every cited example event in one query, then map back per topic.
  const allIds = Array.from(
    new Set(insightRows.flatMap((r) => evidenceIds(r.evidence))),
  );
  const exampleById = new Map<string, ConversationExample>();
  if (allIds.length > 0) {
    const exRows = await db
      .select({
        id: events.id,
        occurredAt: events.occurredAt,
        data: events.data,
      })
      .from(events)
      .where(
        and(
          eq(events.orgId, orgId),
          eq(events.projectId, projectId),
          inArray(events.id, allIds),
        ),
      );
    for (const r of exRows) {
      const d = (r.data ?? {}) as Record<string, unknown>;
      const str = (k: string): string | null =>
        typeof d[k] === "string" ? (d[k] as string) : null;
      exampleById.set(r.id, {
        eventId: r.id,
        occurredAt: r.occurredAt.toISOString(),
        channel: str("channel"),
        intent: str("intent"),
        resolution: str("resolution"),
        sentiment: str("sentiment"),
        summary: str("summary"),
      });
    }
  }

  const topics: TopicCluster[] = insightRows.map((r) => {
    const ev = r.evidence ?? {};
    const ids = evidenceIds(ev);
    return {
      id: r.id,
      title: r.title,
      bodyMd: r.bodyMd,
      confidence: r.confidence,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      count: num(ev["count"]),
      sharePct: num(ev["share_pct"]),
      trend: typeof ev["trend"] === "string" ? (ev["trend"] as string) : "",
      scoutCandidate: ev["scout_candidate"] === true,
      exampleEventIds: ids,
      examples: ids
        .map((id) => exampleById.get(id))
        .filter((e): e is ConversationExample => e !== undefined),
    };
  });
  // Most-common cluster first (share, then count).
  topics.sort((a, b) => b.sharePct - a.sharePct || b.count - a.count);

  return {
    from: c.from_s,
    to: c.to_s,
    totalConversations: total,
    resolution: {
      resolved,
      escalated,
      abandoned: num(c.abandoned),
      total,
    },
    resolutionRate: total > 0 ? round4(resolved / total) : null,
    escalationRate: total > 0 ? round4(escalated / total) : null,
    volumeSeries: volumeRows.map((v) => ({
      periodStart: v.period_start,
      value: num(v.value),
    })),
    sentimentMix: {
      positive: num(c.positive),
      neutral: num(c.neutral),
      negative: num(c.negative),
    },
    topics,
  };
}
