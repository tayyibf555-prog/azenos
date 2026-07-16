import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@azen/db";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import { isUuid } from "../../../../../../lib/server/schemas";
import {
  getProjectForAnalytics,
  parseRange,
} from "../../../../../../lib/server/analytics/base";
import type {
  ConversationsAiData,
  QuestionRow,
  RatioPoint,
  SentimentDay,
  SentimentTopicRow as SentimentTopicMatrixRow,
  TopicRow,
} from "../../../../../../components/analytics/sections/ConversationsAiSection";
import type {
  LabelledValue,
  SeriesPoint,
} from "../../../../../../components/analytics/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

// ── row shapes returned by db.execute (postgres-js: numerics arrive as strings)
interface OverviewRow {
  total: number;
  resolved: number;
  escalated: number;
  abandoned: number;
  positive: number;
  neutral: number;
  negative: number;
  avg_turns: string | null;
  avg_duration: string | null;
}
interface DailyRow {
  period_start: string;
  value: number;
  resolved: number;
  positive: number;
  neutral: number;
  negative: number;
}
interface IntentRow {
  intent: string;
  value: number;
}
interface QuestionSqlRow {
  question: string;
  total: number;
  positive: number;
  neutral: number;
  negative: number;
  escalated: number;
  this_week: number;
  last_week: number;
}
interface TopicSqlRow {
  title: string;
  evidence: Record<string, unknown> | null;
}
interface FcrRow {
  total: number | string;
  fcr: number | string;
}
interface EscalationClusterRow {
  intent: string;
  value: number | string;
}
interface SentimentTopicRow {
  intent: string;
  positive: number | string;
  neutral: number | string;
  negative: number | string;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
/** Ratio in 0..1 rounded to 4dp; null when the denominator is 0. */
const ratio = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 10000) / 10000 : null;

function questionTrend(thisWeek: number, lastWeek: number): QuestionRow["trend"] {
  if (lastWeek === 0) return thisWeek > 0 ? "new" : "flat";
  if (thisWeek > lastWeek * 1.15) return "up";
  if (thisWeek < lastWeek * 0.85) return "down";
  return "flat";
}

function dominantSentiment(
  positive: number,
  neutral: number,
  negative: number,
): QuestionRow["sentiment"] {
  const total = positive + neutral + negative;
  if (total === 0) return "neutral";
  // A meaningful negative slice reads as "mixed" even when neutral leads.
  if (negative > 0 && negative >= total * 0.34) return "mixed";
  if (positive >= neutral && positive >= negative) return "positive";
  if (negative >= positive && negative >= neutral) return "negative";
  return "neutral";
}

/**
 * ANALYTICS · Conversations & AI — the co-pilot brain.
 *
 * Read-only SQL over `events` (type `llm.conversation` — question / messages /
 * topics — plus `message.received`)
 * and `insights` (kind `faq_cluster`), always scoped to (org_id, project_id),
 * London calendar-day windows resolved in Postgres. Returns conversation
 * quality (resolution / escalation / abandonment / deflection, avg turns &
 * duration), a sentiment mix + 30-slice trend, an intent distribution, and the
 * headline QUESTION INTELLIGENCE: every end-user question mined from the
 * co-pilot, ranked by frequency with a this-week-vs-last-week trend, dominant
 * sentiment, and a content-gap flag for questions that escalate or turn
 * negative. Never throws on empty data — every field falls back to zero / [].
 */
export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const r = parseRange(new URL(req.url).searchParams);
  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  const from = r.fromDay;
  const to = r.toDay;

  // ── 1 · overview: quality + sentiment mix + averages (one row) ──────────────
  const overviewRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
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
      (count(*))::int as total,
      (count(*) filter (where data->>'resolution' = 'resolved'))::int as resolved,
      (count(*) filter (where data->>'resolution' = 'escalated'))::int as escalated,
      (count(*) filter (where data->>'resolution' = 'abandoned'))::int as abandoned,
      (count(*) filter (where data->>'sentiment' = 'positive'))::int as positive,
      (count(*) filter (where data->>'sentiment' = 'neutral'))::int as neutral,
      (count(*) filter (where data->>'sentiment' = 'negative'))::int as negative,
      avg((data->>'turns')::numeric) as avg_turns,
      avg((data->>'duration_seconds')::numeric) as avg_duration
    from ev
  `)) as unknown as OverviewRow[];
  const o = overviewRows[0] ?? {
    total: 0,
    resolved: 0,
    escalated: 0,
    abandoned: 0,
    positive: 0,
    neutral: 0,
    negative: 0,
    avg_turns: null,
    avg_duration: null,
  };
  const total = num(o.total);
  const resolved = num(o.resolved);
  const escalated = num(o.escalated);
  const abandoned = num(o.abandoned);

  // ── 2 · daily volume + resolution + sentiment (London day buckets) ──────────
  // Zero-filled across every London day in [from,to] via generate_series (same
  // convention as pulse/route.ts), so quiet and trailing days render as dips to
  // 0 rather than collapsing — the LineChart/MiniTrend space points by index,
  // not by date, so absent days would otherwise compress the x-axis and hide
  // gaps (a stale trend would look current).
  const dailyRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    ),
    days as (
      select generate_series(${from}::date, ${to}::date, interval '1 day')::date as d
    ),
    ev as (
      select
        (e.occurred_at at time zone 'Europe/London')::date as d,
        (count(*))::int as value,
        (count(*) filter (where e.data->>'resolution' = 'resolved'))::int as resolved,
        (count(*) filter (where e.data->>'sentiment' = 'positive'))::int as positive,
        (count(*) filter (where e.data->>'sentiment' = 'neutral'))::int as neutral,
        (count(*) filter (where e.data->>'sentiment' = 'negative'))::int as negative
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.type = 'llm.conversation'
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
      group by 1
    )
    select
      to_char((days.d::timestamp at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as period_start,
      coalesce(ev.value, 0)::int as value,
      coalesce(ev.resolved, 0)::int as resolved,
      coalesce(ev.positive, 0)::int as positive,
      coalesce(ev.neutral, 0)::int as neutral,
      coalesce(ev.negative, 0)::int as negative
    from days
    left join ev on ev.d = days.d
    order by days.d
  `)) as unknown as DailyRow[];

  const volumeSeries: SeriesPoint[] = dailyRows.map((d) => ({
    periodStart: d.period_start,
    value: num(d.value),
  }));
  const resolutionSeries: RatioPoint[] = dailyRows.map((d) => ({
    periodStart: d.period_start,
    value: ratio(num(d.resolved), num(d.value)),
  }));
  const sentimentTrend: SentimentDay[] = dailyRows.map((d) => ({
    periodStart: d.period_start,
    positive: num(d.positive),
    neutral: num(d.neutral),
    negative: num(d.negative),
  }));

  // ── 3 · intent distribution ─────────────────────────────────────────────────
  const intentRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      coalesce(nullif(e.data->>'intent', ''), 'unknown') as intent,
      (count(*))::int as value
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.type = 'llm.conversation'
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    group by 1
    order by value desc, intent asc
    limit 12
  `)) as unknown as IntentRow[];
  const intents: LabelledValue[] = intentRows.map((i) => ({
    label: String(i.intent).replace(/_/g, " "),
    value: num(i.value),
  }));

  // ── 4 · QUESTION INTELLIGENCE ───────────────────────────────────────────────
  // Mine every end-user question the co-pilot heard, from two sources:
  //   • llm.conversation — data.question (fallbacks: first message content /
  //     text, then the first entry of data.topics)
  //   • message.received — data.text (fallback: content / body)
  // Frequency is counted over the SELECTED range (`in_range`); the trend arrow
  // compares the two most-recent 7-day windows relative to "today" (`to`), so a
  // scan spanning both is used, then `in_range` filters the ranked counts.
  const questionRows = (await db.execute(sql`
    with sel as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    ),
    wk as (
      select
        ((${to}::date - 6)::timestamp at time zone 'Europe/London') as this_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as this_end,
        ((${to}::date - 13)::timestamp at time zone 'Europe/London') as last_start,
        ((${to}::date - 6)::timestamp at time zone 'Europe/London') as last_end
    ),
    span as (
      select
        least((select w_start from sel), (select last_start from wk)) as s_start,
        greatest((select w_end from sel), (select this_end from wk)) as s_end
    ),
    src as (
      select
        lower(btrim(coalesce(
          nullif(e.data->>'question', ''),
          nullif(e.data->'messages'->0->>'content', ''),
          nullif(e.data->'messages'->0->>'text', ''),
          nullif(e.data->'topics'->>0, '')
        ))) as q_norm,
        coalesce(
          nullif(e.data->>'question', ''),
          nullif(e.data->'messages'->0->>'content', ''),
          nullif(e.data->'messages'->0->>'text', ''),
          nullif(e.data->'topics'->>0, '')
        ) as q_text,
        e.data->>'sentiment' as sentiment,
        (e.data->>'resolution' = 'escalated') as escalated,
        e.occurred_at
      from events e, span
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.type = 'llm.conversation'
        and e.occurred_at >= span.s_start
        and e.occurred_at < span.s_end
        and coalesce(
          nullif(e.data->>'question', ''),
          nullif(e.data->'messages'->0->>'content', ''),
          nullif(e.data->'messages'->0->>'text', ''),
          nullif(e.data->'topics'->>0, '')
        ) is not null
      union all
      select
        lower(btrim(coalesce(
          nullif(e.data->>'text', ''),
          nullif(e.data->>'content', ''),
          nullif(e.data->>'body', '')
        ))) as q_norm,
        coalesce(
          nullif(e.data->>'text', ''),
          nullif(e.data->>'content', ''),
          nullif(e.data->>'body', '')
        ) as q_text,
        null as sentiment,
        false as escalated,
        e.occurred_at
      from events e, span
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.type = 'message.received'
        and e.occurred_at >= span.s_start
        and e.occurred_at < span.s_end
        and coalesce(
          nullif(e.data->>'text', ''),
          nullif(e.data->>'content', ''),
          nullif(e.data->>'body', '')
        ) is not null
    ),
    tagged as (
      select
        src.q_norm,
        src.q_text,
        src.sentiment,
        src.escalated,
        (src.occurred_at >= sel.w_start and src.occurred_at < sel.w_end) as in_range,
        (src.occurred_at >= wk.this_start and src.occurred_at < wk.this_end) as in_this,
        (src.occurred_at >= wk.last_start and src.occurred_at < wk.last_end) as in_last
      from src, sel, wk
    )
    select
      (array_agg(q_text order by q_text asc))[1] as question,
      (count(*) filter (where in_range))::int as total,
      (count(*) filter (where in_range and sentiment = 'positive'))::int as positive,
      (count(*) filter (where in_range and sentiment = 'neutral'))::int as neutral,
      (count(*) filter (where in_range and sentiment = 'negative'))::int as negative,
      (count(*) filter (where in_range and escalated))::int as escalated,
      (count(*) filter (where in_this))::int as this_week,
      (count(*) filter (where in_last))::int as last_week
    from tagged
    where q_norm is not null and q_norm <> ''
    group by q_norm
    having (count(*) filter (where in_range)) > 0
    order by total desc, question asc
    limit 60
  `)) as unknown as QuestionSqlRow[];

  const questions: QuestionRow[] = questionRows.map((q) => {
    const count = num(q.total);
    const positive = num(q.positive);
    const neutral = num(q.neutral);
    const negative = num(q.negative);
    const esc = num(q.escalated);
    const escalationRate = count > 0 ? Math.round((esc / count) * 10000) / 10000 : 0;
    const negativeRate =
      count > 0 ? Math.round((negative / count) * 10000) / 10000 : 0;
    // A content gap = a question people ask that the co-pilot handles badly:
    // it escalates a lot or sours sentiment. Guard on volume to avoid noise.
    const contentGap = count >= 2 && (escalationRate >= 0.2 || negativeRate >= 0.3);
    return {
      question: q.question ?? "",
      count,
      thisWeek: num(q.this_week),
      lastWeek: num(q.last_week),
      trend: questionTrend(num(q.this_week), num(q.last_week)),
      sentiment: dominantSentiment(positive, neutral, negative),
      escalationRate,
      negativeRate,
      contentGap,
    };
  });
  const questionsTracked = questions.reduce((s, q) => s + q.count, 0);
  const contentGaps = questions
    .filter((q) => q.contentGap)
    .sort(
      (a, b) =>
        b.escalationRate + b.negativeRate - (a.escalationRate + a.negativeRate) ||
        b.count - a.count,
    )
    .slice(0, 8);

  // ── 5 · topic clusters (latest faq_cluster insights, not window-bound) ──────
  const topicRows = (await db.execute(sql`
    select i.title as title, i.evidence as evidence
    from insights i
    where i.org_id = ${orgId}::uuid
      and i.project_id = ${projectId}::uuid
      and i.kind = 'faq_cluster'
      and i.status <> 'dismissed'
    order by i.created_at desc
    limit 24
  `)) as unknown as TopicSqlRow[];
  const topics: TopicRow[] = topicRows
    .map((t) => {
      const ev = t.evidence ?? {};
      return {
        title: t.title,
        count: num(ev["count"]),
        sharePct: num(ev["share_pct"]),
        trend: typeof ev["trend"] === "string" ? (ev["trend"] as string) : "",
      };
    })
    .sort((a, b) => b.sharePct - a.sharePct || b.count - a.count);

  const topQuestions: LabelledValue[] = questions
    .slice(0, 10)
    .map((q) => ({ label: q.question, value: q.count }));

  // ── P9-PACK2 · first-contact resolution (resolved AND turns <= 3) ───────────
  const fcrRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      (count(*))::int as total,
      (count(*) filter (
        where data->>'resolution' = 'resolved'
          and (data->>'turns') is not null
          and (data->>'turns')::numeric <= 3
      ))::int as fcr
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.type = 'llm.conversation'
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
  `)) as unknown as FcrRow[];
  const fcrRow = fcrRows[0] ?? { total: 0, fcr: 0 };
  const fcrTotal = num(fcrRow.total);
  const fcrCount = num(fcrRow.fcr);
  const fcrRate = ratio(fcrCount, fcrTotal);

  // ── P9-PACK2 · escalation root-cause clusters (top intents of escalated convos) ──
  const escalationClusterRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      coalesce(nullif(e.data->>'intent', ''), 'unknown') as intent,
      (count(*))::int as value
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.type = 'llm.conversation'
      and e.data->>'resolution' = 'escalated'
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    group by 1
    order by value desc, intent asc
    limit 8
  `)) as unknown as EscalationClusterRow[];
  const escalationClusters: LabelledValue[] = escalationClusterRows.map((row) => ({
    label: String(row.intent).replace(/_/g, " "),
    value: num(row.value),
  }));

  // ── P9-PACK2 · sentiment-by-topic mini-matrix (top intents × sentiment) ──────
  const sentimentTopicRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      coalesce(nullif(e.data->>'intent', ''), 'unknown') as intent,
      (count(*) filter (where e.data->>'sentiment' = 'positive'))::int as positive,
      (count(*) filter (where e.data->>'sentiment' = 'neutral'))::int as neutral,
      (count(*) filter (where e.data->>'sentiment' = 'negative'))::int as negative
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.type = 'llm.conversation'
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    group by 1
    order by (count(*)) desc, intent asc
    limit 6
  `)) as unknown as SentimentTopicRow[];
  const sentimentByTopic: SentimentTopicMatrixRow[] = sentimentTopicRows.map((row) => ({
    intent: String(row.intent).replace(/_/g, " "),
    positive: num(row.positive),
    neutral: num(row.neutral),
    negative: num(row.negative),
  }));

  const body: ConversationsAiData = {
    range: r.range,
    from,
    to,
    totalConversations: total,
    resolvedCount: resolved,
    escalatedCount: escalated,
    abandonedCount: abandoned,
    resolutionRate: ratio(resolved, total),
    escalationRate: ratio(escalated, total),
    abandonmentRate: ratio(abandoned, total),
    // Deflection = share self-served to a resolution — neither escalated to a
    // human NOR abandoned. Abandoned conversations (caller dropped off) are a
    // failure, not a deflection, so they are excluded from the numerator.
    deflectionRate: ratio(total - escalated - abandoned, total),
    avgTurns: o.avg_turns === null ? null : Math.round(num(o.avg_turns) * 10) / 10,
    avgDurationSeconds:
      o.avg_duration === null ? null : Math.round(num(o.avg_duration)),
    volumeSeries,
    resolutionSeries,
    sentimentMix: {
      positive: num(o.positive),
      neutral: num(o.neutral),
      negative: num(o.negative),
    },
    sentimentTrend,
    intents,
    topQuestions,
    questions,
    contentGaps,
    questionsTracked,
    topics,
    fcr: { rate: fcrRate, count: fcrCount, total: fcrTotal },
    escalationClusters,
    sentimentByTopic,
  };
  return NextResponse.json(body);
});
