import { z } from "zod";
import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { briefs, db, insights, upsellProposals } from "@azen/db";
import { defineTool } from "./types";
import { escapeLike } from "./shared";

/**
 * search_briefs_insights — one search across the three agent-output tables
 * (briefs, insights, upsell_proposals), org-scoped, newest-first, capped at 30
 * ROWS TOTAL. `text` matches each table's headline/title + body. `kind` targets
 * insight kinds (so it narrows to insights). `status` is matched against
 * whichever of the three status vocabularies contains it — a table whose status
 * enum doesn't include the value is simply excluded (no leak, no error).
 */

const TOTAL_CAP = 30;

const insightKinds = [
  "automation_opportunity",
  "upsell",
  "risk",
  "win",
  "anomaly",
  "faq_cluster",
] as const;

const briefStatuses = new Set(["generated", "sent", "failed"]);
const insightStatuses = new Set([
  "new",
  "reviewed",
  "actioned",
  "dismissed",
  "converted_to_upsell",
]);
const proposalStatuses = new Set(["draft", "ready", "sent", "won", "lost"]);

interface Hit {
  source: "brief" | "insight" | "upsell_proposal";
  id: string;
  title: string;
  bodyMd: string;
  kind: string | null;
  status: string;
  createdAt: Date;
}

export const searchBriefsInsights = defineTool({
  name: "search_briefs_insights",
  description:
    "Search the agent-authored outputs — daily/weekly/monthly briefs, insights (anomalies, risks, wins, automation opportunities, FAQ clusters), and upsell proposals — org-scoped, newest-first, capped at 30 results total. Filter by free text (matches headline/title and body), kind (an insight kind: automation_opportunity/upsell/risk/win/anomaly/faq_cluster — narrows to insights), and status (matched against brief/insight/proposal status vocabularies). Use this for 'what did the daily brief say', 'any open anomalies', 'what upsells are ready'.",
  inputSchema: z
    .object({
      text: z.string().min(1).optional(),
      kind: z.enum(insightKinds).optional(),
      status: z.string().min(1).optional(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  run: async (orgId, input) => {
    const cap = Math.min(input.limit ?? TOTAL_CAP, TOTAL_CAP);
    const pattern =
      input.text !== undefined ? `%${escapeLike(input.text)}%` : undefined;
    const status = input.status;

    const hits: Hit[] = [];

    // Insights — always eligible (kind only applies here).
    {
      const conds: SQL[] = [eq(insights.orgId, orgId)];
      if (input.kind !== undefined) conds.push(eq(insights.kind, input.kind));
      if (status !== undefined) {
        if (!insightStatuses.has(status)) conds.push(sql`false`);
        else conds.push(sql`${insights.status}::text = ${status}`);
      }
      if (pattern) {
        const c = or(
          sql`${insights.title} ilike ${pattern}`,
          sql`${insights.bodyMd} ilike ${pattern}`,
        );
        if (c) conds.push(c);
      }
      const rows = await db
        .select({
          id: insights.id,
          title: insights.title,
          bodyMd: insights.bodyMd,
          kind: insights.kind,
          status: insights.status,
          createdAt: insights.createdAt,
        })
        .from(insights)
        .where(and(...conds))
        .orderBy(desc(insights.createdAt), desc(insights.id))
        .limit(cap);
      for (const r of rows)
        hits.push({ source: "insight", ...r, kind: r.kind });
    }

    // Briefs — excluded when a kind filter is set (briefs have no kind), or when
    // a status filter names a value that isn't a brief status.
    if (input.kind === undefined && (status === undefined || briefStatuses.has(status))) {
      const conds: SQL[] = [eq(briefs.orgId, orgId)];
      if (status !== undefined) conds.push(sql`${briefs.status}::text = ${status}`);
      if (pattern) {
        const c = or(
          sql`${briefs.headline} ilike ${pattern}`,
          sql`${briefs.bodyMd} ilike ${pattern}`,
        );
        if (c) conds.push(c);
      }
      const rows = await db
        .select({
          id: briefs.id,
          headline: briefs.headline,
          bodyMd: briefs.bodyMd,
          status: briefs.status,
          createdAt: briefs.createdAt,
        })
        .from(briefs)
        .where(and(...conds))
        .orderBy(desc(briefs.createdAt), desc(briefs.id))
        .limit(cap);
      for (const r of rows)
        hits.push({
          source: "brief",
          id: r.id,
          title: r.headline,
          bodyMd: r.bodyMd,
          kind: null,
          status: r.status,
          createdAt: r.createdAt,
        });
    }

    // Upsell proposals — excluded when a kind filter is set, or when a status
    // filter names a value that isn't a proposal status.
    if (
      input.kind === undefined &&
      (status === undefined || proposalStatuses.has(status))
    ) {
      const conds: SQL[] = [eq(upsellProposals.orgId, orgId)];
      if (status !== undefined)
        conds.push(sql`${upsellProposals.status}::text = ${status}`);
      if (pattern) {
        const c = or(
          sql`${upsellProposals.title} ilike ${pattern}`,
          sql`${upsellProposals.problemMd} ilike ${pattern}`,
          sql`${upsellProposals.proposalMd} ilike ${pattern}`,
        );
        if (c) conds.push(c);
      }
      const rows = await db
        .select({
          id: upsellProposals.id,
          title: upsellProposals.title,
          problemMd: upsellProposals.problemMd,
          status: upsellProposals.status,
          createdAt: upsellProposals.createdAt,
        })
        .from(upsellProposals)
        .where(and(...conds))
        .orderBy(desc(upsellProposals.createdAt), desc(upsellProposals.id))
        .limit(cap);
      for (const r of rows)
        hits.push({
          source: "upsell_proposal",
          id: r.id,
          title: r.title,
          bodyMd: r.problemMd,
          kind: null,
          status: r.status,
          createdAt: r.createdAt,
        });
    }

    hits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const results = hits.slice(0, cap);
    return { ok: true, data: { results, count: results.length } };
  },
});
