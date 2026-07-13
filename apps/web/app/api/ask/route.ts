import Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq } from "drizzle-orm";
import { CHAT_MODEL } from "@azen/config";
import { chatMessages, chatSessions, db, users } from "@azen/db";
import { checkBudget } from "@azen/agents";
import { z } from "zod";
import { jsonError, withErrorHandling } from "../../../lib/server/http";
import { requireOrgId } from "../../../lib/server/org";
import { isUuid, readJsonBody, zodSummary } from "../../../lib/server/schemas";
import { getSessionUser, supabaseConfigured } from "../../../lib/supabase";
import { buildSystemPrompt, type AskPageContext } from "../../../lib/server/ask/prompt";
import {
  runAskLoop,
  type AskHistoryTurn,
  type AskResult,
} from "../../../lib/server/ask/loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ask — the Ask Azen streaming chat endpoint (docs/phase3b/
 * CONTRACTS.md §P3B-CHAT, spec §9.8). Budget-guards first (a monthly-cap halt
 * returns a canned message with ZERO model calls), persists the user message,
 * runs the tool-use loop on CHAT_MODEL, streams Server-Sent Events (text deltas
 * + tool markers) to the client, and on completion persists the assistant
 * chat_message with the full tool-call trace + tokens + cost. chat_messages IS
 * the chat ledger; its cost counts toward the budget via checkBudget, which
 * sums chat_messages alongside agent_runs (§13) — so persisting the cost here
 * is what makes chat spend count. Provider errors map to friendly SSE events;
 * raw detail never reaches the client (spec §15).
 */

// The Ask UI sends page context as snake_case `{ project_id }` (components/ask/
// types.ts, context.ts) — the stored chat_sessions.context shape. Accept the
// snake_case key (and tolerate camelCase) and normalize to the camelCase
// AskPageContext the prompt + mergeContext consume, so a question asked from
// /projects/<id> is actually scoped. Plain `.strip()` on a camelCase-only schema
// silently dropped `project_id`, un-scoping every project question.
const contextSchema = z
  .object({
    project_id: z.string().optional(),
    projectId: z.string().optional(),
    projectSlug: z.string().optional(),
    projectName: z.string().optional(),
    clientId: z.string().optional(),
    clientName: z.string().optional(),
  })
  .strip()
  .transform((c) => ({
    projectId: c.projectId ?? c.project_id,
    projectSlug: c.projectSlug,
    projectName: c.projectName,
    clientId: c.clientId,
    clientName: c.clientName,
  }));

const bodySchema = z.object({
  sessionId: z.string().optional(),
  message: z.string().trim().min(1).max(4000),
  context: contextSchema.optional(),
});

/** pence → "£1,250.00" */
function gbp(pence: number): string {
  return `£${(pence / 100).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The user id to attribute a session to. Hosted: the authenticated user (whose
 * org requireOrgId already verified). Demo/local: the org's owner row. Single
 * -owner v1 (spec §15) — chat_sessions.userId is NOT NULL, so one is required.
 */
async function resolveUserId(orgId: string): Promise<string | null> {
  if (supabaseConfigured()) {
    const u = await getSessionUser();
    if (u) return u.id;
  }
  const row = await db.query.users.findFirst({
    where: eq(users.orgId, orgId),
    orderBy: (t, { asc: a }) => [a(t.createdAt)],
    columns: { id: true },
  });
  return row?.id ?? null;
}

export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();

  const parsed = bodySchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  const { sessionId, message, context } = parsed.data;

  const userId = await resolveUserId(orgId);
  if (!userId) return jsonError(400, "no_user_for_org");

  // ── resolve or create the session (org-checked, no cross-org) ───────────────
  let session: { id: string; context: Record<string, unknown> };
  let history: AskHistoryTurn[] = [];
  if (sessionId) {
    if (!isUuid(sessionId)) return jsonError(404, "session_not_found");
    const row = await db.query.chatSessions.findFirst({
      where: and(eq(chatSessions.id, sessionId), eq(chatSessions.orgId, orgId)),
      columns: { id: true, context: true },
    });
    if (!row) return jsonError(404, "session_not_found");
    session = row;
    const prior = await db.query.chatMessages.findMany({
      where: eq(chatMessages.sessionId, row.id),
      orderBy: [asc(chatMessages.createdAt)],
      columns: { role: true, contentMd: true },
    });
    history = prior
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", contentMd: m.contentMd }));
  } else {
    const [created] = await db
      .insert(chatSessions)
      .values({
        orgId,
        userId,
        title: message.slice(0, 60),
        context: (context ?? {}) as Record<string, unknown>,
      })
      .returning({ id: chatSessions.id, context: chatSessions.context });
    if (!created) return jsonError(500, "session_create_failed");
    session = created;
  }

  // Persist the user turn immediately (part of the ledger even if the answer
  // errors mid-stream).
  await db.insert(chatMessages).values({
    orgId,
    sessionId: session.id,
    role: "user",
    contentMd: message,
  });

  const encoder = new TextEncoder();

  // ── budget guard: a halt returns the canned message, ZERO model calls ───────
  const budget = await checkBudget(orgId);
  if (budget.state === "halt") {
    const canned = `AI budget for this month is used up (${gbp(budget.spentPence)} of ${gbp(budget.capPence)}). Ask again next month, or raise AGENT_BUDGET_PENCE_MONTHLY.`;
    await db.insert(chatMessages).values({
      orgId,
      sessionId: session.id,
      role: "assistant",
      contentMd: canned,
      model: null,
      costEstimatePence: 0,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse("text", { delta: canned })));
        controller.enqueue(
          encoder.encode(sse("done", { sessionId: session.id, budgetHalt: true })),
        );
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: sseHeaders() });
  }

  // ── run the loop, stream SSE, persist the assistant turn on completion ──────
  const systemPrompt = buildSystemPrompt(
    mergeContext(session.context, context),
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sse(event, data)));
      // Hoisted so the catch can persist whatever usage the loop accumulated
      // before a mid-stream provider error.
      let partial: AskResult | null = null;
      try {
        let result: AskResult | null = null;
        for await (const ev of runAskLoop({
          orgId,
          systemPrompt,
          history,
          userMessage: message,
        })) {
          if (ev.type === "done") {
            result = ev.result;
          } else if (ev.type === "partial") {
            // Usage accumulated before a mid-stream provider error (see catch).
            partial = ev.result;
          } else {
            send(ev.type, ev);
          }
        }

        if (result) {
          const [row] = await db
            .insert(chatMessages)
            .values({
              orgId,
              sessionId: session.id,
              role: "assistant",
              contentMd: result.contentMd,
              toolCalls: result.toolCalls,
              model: CHAT_MODEL,
              tokensIn: result.tokensIn,
              tokensOut: result.tokensOut,
              costEstimatePence: result.costEstimatePence,
            })
            .returning({ id: chatMessages.id });
          send("done", {
            sessionId: session.id,
            messageId: row?.id ?? null,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            costEstimatePence: result.costEstimatePence,
          });
        }
      } catch (err) {
        const friendly = mapChatError(err);
        send("error", { error: friendly });
        // Persist an assistant row for the failed turn so that (a) tokens already
        // spent before the error still count toward the monthly budget (§13 —
        // chat_messages IS the ledger) and (b) the user turn is answered:
        // otherwise the unanswered user message replays next request and, being a
        // second consecutive user message, gets merged with the new question.
        const spent = partial ?? {
          contentMd: "",
          toolCalls: [],
          tokensIn: 0,
          tokensOut: 0,
          costEstimatePence: 0,
          stoppedAtCap: false,
        };
        try {
          await db.insert(chatMessages).values({
            orgId,
            sessionId: session.id,
            role: "assistant",
            contentMd:
              spent.contentMd.trim() !== "" ? spent.contentMd : `_${friendly}_`,
            toolCalls: spent.toolCalls,
            model: CHAT_MODEL,
            tokensIn: spent.tokensIn,
            tokensOut: spent.tokensOut,
            costEstimatePence: spent.costEstimatePence,
          });
        } catch (persistErr) {
          console.error("[api/ask] failed to persist interrupted turn:", persistErr);
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
});

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  };
}

/** Session-start context (stored) overlaid with this request's page context. */
function mergeContext(
  stored: Record<string, unknown>,
  reqCtx: AskPageContext | undefined,
): AskPageContext {
  const pick = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  return {
    projectId: reqCtx?.projectId ?? pick(stored.projectId),
    projectSlug: reqCtx?.projectSlug ?? pick(stored.projectSlug),
    projectName: reqCtx?.projectName ?? pick(stored.projectName),
    clientId: reqCtx?.clientId ?? pick(stored.clientId),
    clientName: reqCtx?.clientName ?? pick(stored.clientName),
  };
}

/**
 * Map a provider error to a friendly, non-raw SSE message (spec §15). A missing
 * ANTHROPIC_API_KEY surfaces as an AuthenticationError (or a construction error
 * mentioning the key) — the UI shows the "set a key" banner.
 */
function mapChatError(err: unknown): string {
  if (
    err instanceof Anthropic.AuthenticationError ||
    (err instanceof Error && /ANTHROPIC_API_KEY/i.test(err.message))
  ) {
    return "ANTHROPIC_API_KEY not set";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Azen is rate-limited right now — please try again in a moment.";
  }
  console.error("[api/ask] chat loop failed:", err);
  return "Something went wrong answering that. Please try again.";
}
