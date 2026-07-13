import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import {
  agentRuns,
  chatMessages,
  chatSessions,
  db,
  organizations,
  users,
} from "@azen/db";
import type {
  AskAnthropicClient,
  AskMessageStream,
  AskResult,
} from "../../lib/server/ask/loop";
import { MAX_TOOL_CALLS, runAskLoop } from "../../lib/server/ask/loop";

/**
 * P3B-CHAT loop + route tests (docs/phase3b/CONTRACTS.md). NO live API calls:
 * the loop tests inject a scripted fake client via deps; the route tests mock
 * @azen/agents' getAnthropic (checkBudget stays REAL, reading the throwaway
 * org's ledger). Two throwaway orgs, full cleanup, DEMO_ORG_ID untouched.
 */

const h = vi.hoisted(() => ({
  orgId: { value: "" },
  streamFn: { impl: null as null | ((params: unknown) => AskMessageStream) },
}));

// getAnthropic → our scripted fake; checkBudget stays the real DB-backed one.
vi.mock("@azen/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azen/agents")>();
  return {
    ...actual,
    getAnthropic: () => ({
      messages: {
        stream: (params: unknown) => {
          if (!h.streamFn.impl) throw new Error("no scripted stream set");
          return h.streamFn.impl(params);
        },
      },
    }),
  };
});

vi.mock("../../lib/server/org", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...actual, requireOrgId: async () => h.orgId.value };
});

vi.mock("../../lib/supabase", () => ({
  supabaseConfigured: () => false,
  getSessionUser: async () => null,
}));

import { POST } from "../../app/api/ask/route";

// ── scripted-stream helpers ─────────────────────────────────────────────────
interface FakeTurn {
  deltas: string[];
  content: Anthropic.ContentBlock[];
  stopReason: "tool_use" | "end_turn";
  usage: { input_tokens: number; output_tokens: number };
}

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text, citations: [] } as unknown as Anthropic.ContentBlock;
}
function toolUseBlock(
  id: string,
  name: string,
  input: unknown,
): Anthropic.ContentBlock {
  return { type: "tool_use", id, name, input } as unknown as Anthropic.ContentBlock;
}
function textDeltaEvent(text: string): Anthropic.RawMessageStreamEvent {
  return {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  } as unknown as Anthropic.RawMessageStreamEvent;
}

function makeStream(turn: FakeTurn): AskMessageStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const d of turn.deltas) yield textDeltaEvent(d);
    },
    finalMessage: async () =>
      ({
        content: turn.content,
        stop_reason: turn.stopReason,
        usage: turn.usage,
      }) as unknown as Anthropic.Message,
  };
}

/** A client that plays a fixed script of turns, one per stream() call. */
function scriptedClient(turns: FakeTurn[]): {
  client: AskAnthropicClient;
  calls: () => number;
} {
  let i = 0;
  return {
    client: {
      messages: {
        stream: () => {
          const turn = turns[Math.min(i, turns.length - 1)] as FakeTurn;
          i += 1;
          return makeStream(turn);
        },
      },
    },
    calls: () => i,
  };
}

// Throwaway orgs (A = loop/route tests, B = budget-halt).
const orgA = randomUUID();
const orgB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();

async function seedOrg(orgId: string, userId: string): Promise<void> {
  await db.insert(organizations).values({ id: orgId, name: `Ask Chat ${orgId.slice(0, 8)}` });
  await db.insert(users).values({
    id: userId,
    orgId,
    name: "Owner",
    email: `owner-${orgId.slice(0, 8)}@test.local`,
  });
}

beforeAll(async () => {
  await seedOrg(orgA, userA);
  await seedOrg(orgB, userB);
});

afterAll(async () => {
  for (const o of [orgA, orgB]) {
    await db.delete(chatMessages).where(eq(chatMessages.orgId, o));
    await db.delete(chatSessions).where(eq(chatSessions.orgId, o));
    await db.delete(agentRuns).where(eq(agentRuns.orgId, o));
    await db.delete(users).where(eq(users.orgId, o));
    await db.delete(organizations).where(eq(organizations.id, o));
  }
});

function askReq(body: unknown): Request {
  return new Request("http://test.local/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("runAskLoop", () => {
  it("calls the requested tool, streams text, and returns the trace + summed tokens", async () => {
    const { client } = scriptedClient([
      {
        deltas: [],
        content: [toolUseBlock("tu1", "get_business_snapshot", {})],
        stopReason: "tool_use",
        usage: { input_tokens: 100_000, output_tokens: 20_000 },
      },
      {
        deltas: ["You have ", "data."],
        content: [textBlock("You have data.")],
        stopReason: "end_turn",
        usage: { input_tokens: 50_000, output_tokens: 10_000 },
      },
    ]);

    const seen: string[] = [];
    let result: AskResult | undefined;
    for await (const ev of runAskLoop(
      { orgId: orgA, systemPrompt: "sys", userMessage: "how are we doing?" },
      { getClient: () => client },
    )) {
      seen.push(ev.type);
      if (ev.type === "done") result = ev.result;
    }

    expect(result).toBeDefined();
    const r = result as AskResult;
    // Right tool called exactly once, org-scoped run succeeded.
    expect(r.toolCalls).toHaveLength(1);
    const call = r.toolCalls[0]!;
    expect(call.name).toBe("get_business_snapshot");
    expect(call.ok).toBe(true);
    expect(typeof call.resultSummary).toBe("string");
    // Final answer is the last turn's text.
    expect(r.contentMd).toBe("You have data.");
    // Tokens summed across both turns.
    expect(r.tokensIn).toBe(150_000);
    expect(r.tokensOut).toBe(30_000);
    // Cost = round((150000*0.03 + 30000*0.15)/1000) = round(9) = 9 pence.
    expect(r.costEstimatePence).toBe(9);
    expect(r.stoppedAtCap).toBe(false);
    // Streamed a tool marker, a tool_result marker, and text deltas.
    expect(seen).toContain("tool");
    expect(seen).toContain("tool_result");
    expect(seen).toContain("text");
  });

  it("hard-caps at MAX_TOOL_CALLS tool executions, then forces a final answer", async () => {
    // A client that always asks for a tool while tools are offered.
    let calls = 0;
    const client: AskAnthropicClient = {
      messages: {
        stream: (params) => {
          calls += 1;
          const offered = params.tools !== undefined;
          if (offered) {
            return makeStream({
              deltas: [],
              content: [toolUseBlock(`tu${calls}`, "get_business_snapshot", {})],
              stopReason: "tool_use",
              usage: { input_tokens: 10, output_tokens: 5 },
            });
          }
          return makeStream({
            deltas: ["capped answer"],
            content: [textBlock("capped answer")],
            stopReason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        },
      },
    };

    let result: AskResult | undefined;
    for await (const ev of runAskLoop(
      { orgId: orgA, systemPrompt: "sys", userMessage: "loop forever" },
      { getClient: () => client },
    )) {
      if (ev.type === "done") result = ev.result;
    }

    const r = result as AskResult;
    expect(r.toolCalls).toHaveLength(MAX_TOOL_CALLS);
    expect(r.stoppedAtCap).toBe(true);
    expect(r.contentMd).toBe("capped answer");
    // 12 tool turns (with tools) + 1 forced tool-less final = 13 model calls.
    expect(calls).toBe(MAX_TOOL_CALLS + 1);
  });
});

describe("POST /api/ask", () => {
  it("persists the assistant message with the tool_calls trace, tokens, and cost", async () => {
    h.orgId.value = orgA;
    // Script the route's (mocked) client: tool_use → final answer.
    let turn = 0;
    h.streamFn.impl = () => {
      turn += 1;
      if (turn === 1) {
        return makeStream({
          deltas: [],
          content: [toolUseBlock("tu1", "get_business_snapshot", {})],
          stopReason: "tool_use",
          usage: { input_tokens: 4_000, output_tokens: 800 },
        });
      }
      return makeStream({
        deltas: ["Here is ", "the answer."],
        content: [textBlock("Here is the answer.")],
        stopReason: "end_turn",
        usage: { input_tokens: 2_000, output_tokens: 400 },
      });
    };

    const res = await POST(askReq({ message: "how are we doing this month?" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    // SSE relayed tool markers and a terminal done event.
    expect(text).toContain("event: tool");
    expect(text).toContain("event: tool_result");
    expect(text).toContain("event: done");

    const done = JSON.parse(
      (text.match(/event: done\ndata: (\{.*?\})\n/) as RegExpMatchArray)[1]!,
    ) as { sessionId: string; messageId: string };
    expect(done.sessionId).toBeTruthy();

    const row = await db.query.chatMessages.findFirst({
      where: eq(chatMessages.id, done.messageId),
    });
    expect(row).toBeDefined();
    const msg = row as NonNullable<typeof row>;
    expect(msg.role).toBe("assistant");
    expect(msg.contentMd).toBe("Here is the answer.");
    expect(msg.model).toBeTruthy();
    // Tokens summed across both scripted turns.
    expect(msg.tokensIn).toBe(6_000);
    expect(msg.tokensOut).toBe(1_200);
    // Trace persisted (the "how I got this" data).
    const trace = msg.toolCalls as { name: string; ok: boolean }[];
    expect(trace).toHaveLength(1);
    expect(trace[0]!.name).toBe("get_business_snapshot");
    // A user message was persisted too.
    const userMsg = await db.query.chatMessages.findFirst({
      where: eq(chatMessages.sessionId, done.sessionId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    expect(userMsg?.role).toBe("user");
  });

  it("halts on an exceeded budget with a canned message and ZERO model calls", async () => {
    h.orgId.value = orgB;
    // Push orgB over the monthly cap via a big agent_runs cost this month.
    await db.insert(agentRuns).values({
      orgId: orgB,
      agent: "daily_brief",
      status: "succeeded",
      startedAt: new Date(),
      costEstimatePence: 9_999_999,
    });
    // If the model is called, fail loudly.
    const spy = vi.fn(() => {
      throw new Error("model must not be called on budget halt");
    });
    h.streamFn.impl = spy as unknown as (p: unknown) => AskMessageStream;

    const res = await POST(askReq({ message: "anything at all" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.toLowerCase()).toContain("budget");
    expect(text).not.toContain("event: error");
    expect(spy).not.toHaveBeenCalled();

    // The canned assistant message was persisted at zero cost, no model.
    const assistant = await db.query.chatMessages.findFirst({
      where: eq(chatMessages.orgId, orgB),
      orderBy: [desc(chatMessages.createdAt)],
    });
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.costEstimatePence).toBe(0);
    expect(assistant?.model).toBeNull();
  });
});
