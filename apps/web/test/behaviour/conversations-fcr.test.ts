import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  noonOnDaysAgo,
} from "../metrics-api/helpers";
import { insertBehaviourEvent } from "./helpers";
import type { ConversationsAiData } from "../../components/analytics/sections/ConversationsAiSection";

/**
 * P9-PACK2 — Conversations & AI additive blocks: first-contact resolution
 * (resolved AND turns <= 3), escalation root-cause clusters (top intents of
 * ESCALATED conversations only), and the sentiment-by-topic mini-matrix (all
 * conversations, any resolution, grouped by intent). One hand-built set of 10
 * conversations drives all three — every count is computed in the table below.
 *
 *  id   intent      sentiment  resolution  turns   FCR?  escalation-cluster?
 *  C1   billing     positive   resolved    2       yes   -
 *  C2   billing     negative   escalated   5       -     billing
 *  C3   billing     negative   escalated   6       -     billing
 *  C4   billing     neutral    escalated   4       -     billing
 *  C5   technical   negative   escalated   3       -     technical
 *  C6   technical   positive   resolved    6       no*   -
 *  C7   technical   neutral    escalated   5       -     technical
 *  C8   onboarding  positive   escalated   2       -     onboarding
 *  C9   onboarding  positive   resolved    3       yes   -
 *  C10  billing     positive   resolved    (none)  no**  -
 *  * turns=6 > 3.  ** turns missing entirely.
 *
 * FCR = 2/10 = 0.2. Escalation clusters: billing=3, technical=2, onboarding=1.
 * Sentiment-by-topic: billing {pos:2,neu:1,neg:2}, technical {pos:1,neu:1,neg:1},
 * onboarding {pos:2,neu:0,neg:0}, ordered by total conversations desc.
 */

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET } from "../../app/api/projects/[projectId]/analytics/conversations-ai/route";

let projectId: string;
let emptyProjectId: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId, { name: "Conversations FCR Fixture" });
  emptyProjectId = await createProject(TEST_ORG_ID, clientId, { name: "Conversations FCR Empty" });

  const at = noonOnDaysAgo(5);
  const conversations: {
    intent: string;
    sentiment: string;
    resolution: string;
    turns?: number;
  }[] = [
    { intent: "billing", sentiment: "positive", resolution: "resolved", turns: 2 }, // C1
    { intent: "billing", sentiment: "negative", resolution: "escalated", turns: 5 }, // C2
    { intent: "billing", sentiment: "negative", resolution: "escalated", turns: 6 }, // C3
    { intent: "billing", sentiment: "neutral", resolution: "escalated", turns: 4 }, // C4
    { intent: "technical", sentiment: "negative", resolution: "escalated", turns: 3 }, // C5
    { intent: "technical", sentiment: "positive", resolution: "resolved", turns: 6 }, // C6
    { intent: "technical", sentiment: "neutral", resolution: "escalated", turns: 5 }, // C7
    { intent: "onboarding", sentiment: "positive", resolution: "escalated", turns: 2 }, // C8
    { intent: "onboarding", sentiment: "positive", resolution: "resolved", turns: 3 }, // C9
    { intent: "billing", sentiment: "positive", resolution: "resolved" }, // C10, no turns
  ];

  for (const c of conversations) {
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "llm.conversation",
      occurredAt: at,
      data: {
        intent: c.intent,
        sentiment: c.sentiment,
        resolution: c.resolution,
        ...(c.turns !== undefined ? { turns: c.turns } : {}),
      },
    });
  }
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

async function getConversationsAi(pid: string): Promise<ConversationsAiData> {
  const res = await GET(new Request("http://t/api?range=30d"), {
    params: Promise.resolve({ projectId: pid }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ConversationsAiData;
}

describe("GET /api/projects/[projectId]/analytics/conversations-ai — FCR", () => {
  it("counts only resolved conversations with turns <= 3", async () => {
    const body = await getConversationsAi(projectId);
    expect(body.fcr).toEqual({ rate: 0.2, count: 2, total: 10 });
  });

  it("degrades to a null rate on an empty project", async () => {
    const body = await getConversationsAi(emptyProjectId);
    expect(body.fcr).toEqual({ rate: null, count: 0, total: 0 });
  });
});

describe("GET /api/projects/[projectId]/analytics/conversations-ai — escalation clusters", () => {
  it("ranks intents of ESCALATED conversations only", async () => {
    const body = await getConversationsAi(projectId);
    expect(body.escalationClusters).toEqual([
      { label: "billing", value: 3 },
      { label: "technical", value: 2 },
      { label: "onboarding", value: 1 },
    ]);
  });

  it("returns an empty list with no escalations", async () => {
    const body = await getConversationsAi(emptyProjectId);
    expect(body.escalationClusters).toEqual([]);
  });
});

describe("GET /api/projects/[projectId]/analytics/conversations-ai — sentiment by topic", () => {
  it("builds the intent × sentiment mini-matrix across ALL resolutions", async () => {
    const body = await getConversationsAi(projectId);
    expect(body.sentimentByTopic).toEqual([
      { intent: "billing", positive: 2, neutral: 1, negative: 2 },
      { intent: "technical", positive: 1, neutral: 1, negative: 1 },
      { intent: "onboarding", positive: 2, neutral: 0, negative: 0 },
    ]);
  });

  it("returns an empty matrix on an empty project", async () => {
    const body = await getConversationsAi(emptyProjectId);
    expect(body.sentimentByTopic).toEqual([]);
  });
});
