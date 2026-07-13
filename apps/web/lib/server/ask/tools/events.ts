import { z } from "zod";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db, events, projects } from "@azen/db";
import { defineTool } from "./types";
import { escapeLike, resolveProjectIdBySlug, timestampRangeConds } from "./shared";

/**
 * search_events — org-scoped read of the event spine. Optional project_slug,
 * exact type, from/to (on occurred_at), and free-text (matched against the JSON
 * data and the subject name). Newest-first, capped at 50 rows so the model never
 * pulls an unbounded slice of raw events into context.
 */

const LIMIT_CAP = 50;

export const searchEvents = defineTool({
  name: "search_events",
  description:
    "Search the raw event spine (every signal a client system emits: bookings, conversations, payments, agent runs, errors, etc.), org-scoped and newest-first. Filter by project_slug, exact event type (e.g. 'booking.created'), from/to dates on occurred_at (YYYY-MM-DD or ISO), and free text (matches the event data JSON and subject name). limit defaults to 50 and is capped at 50. Prefer query_metric_rollups for counts/trends — this is for inspecting individual events.",
  inputSchema: z
    .object({
      project_slug: z.string().min(1).optional(),
      type: z.string().min(1).optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  run: async (orgId, input) => {
    const conds: SQL[] = [eq(events.orgId, orgId)];

    if (input.project_slug !== undefined) {
      const projectId = await resolveProjectIdBySlug(orgId, input.project_slug);
      if (projectId === null) {
        return {
          ok: true,
          data: {
            events: [],
            note: `no project '${input.project_slug}' in this org`,
          },
        };
      }
      conds.push(eq(events.projectId, projectId));
    }

    if (input.type !== undefined) conds.push(eq(events.type, input.type));
    conds.push(...timestampRangeConds(events.occurredAt, input.from, input.to));

    if (input.text !== undefined) {
      const pattern = `%${escapeLike(input.text)}%`;
      const textCond = or(
        sql`${events.data}::text ilike ${pattern}`,
        sql`${events.subject}->>'name' ilike ${pattern}`,
        ilike(events.type, pattern),
      );
      if (textCond) conds.push(textCond);
    }

    const limit = Math.min(input.limit ?? LIMIT_CAP, LIMIT_CAP);
    const rows = await db
      .select({
        id: events.id,
        type: events.type,
        occurredAt: events.occurredAt,
        projectId: events.projectId,
        projectName: sql<string>`coalesce(${projects.name}, 'Agency')`,
        subjectName: sql<string | null>`${events.subject}->>'name'`,
        data: events.data,
        valuePence: events.valuePence,
        minutesSaved: events.minutesSaved,
      })
      .from(events)
      .leftJoin(projects, eq(events.projectId, projects.id))
      .where(and(...conds))
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit);

    return { ok: true, data: { events: rows, count: rows.length } };
  },
});
