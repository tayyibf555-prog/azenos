import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_MODEL } from "@azen/config";
import { agentRuns, db } from "@azen/db";
import { eq } from "drizzle-orm";
import type { ProjectDraft } from "../../lib/server/intake/schema";
import {
  cleanupIntakeHarness,
  clearAgentRuns,
  createIntakeHarness,
  makeDraft,
  type IntakeHarness,
} from "./helpers";

// Hoisted so the vi.mock factories (also hoisted) can close over them.
const h = vi.hoisted(() => ({
  parseMock: vi.fn(),
  orgId: { value: "" },
}));

// The ONLY Anthropic access funnels through getAnthropic() — mock it, no live calls.
vi.mock("../../lib/server/intake/anthropic", () => ({
  getAnthropic: () => ({ messages: { parse: h.parseMock } }),
}));

// Route DB writes must land on a throwaway org, never the demo org.
vi.mock("../../lib/server/org", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...actual, requireOrgId: async () => h.orgId.value };
});

import { POST as intakePOST } from "../../app/api/projects/intake/route";
import { POST as refinePOST } from "../../app/api/projects/intake/refine/route";
import { runIntakeAgent } from "../../lib/server/intake/run";
import { projectDraftSchema } from "../../lib/server/intake/schema";

interface DraftEnvelope {
  draft: ProjectDraft;
  runId: string;
}
interface RefineEnvelope extends DraftEnvelope {
  note: string;
}
interface ErrorEnvelope {
  error: string;
}

function parseOk(parsed: unknown, tokensIn = 1200, tokensOut = 320) {
  return {
    parsed_output: parsed,
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
  };
}

function intakeReq(body: unknown): Request {
  return new Request("http://test.local/api/projects/intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function refineReq(body: unknown): Request {
  return new Request("http://test.local/api/projects/intake/refine", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TRANSCRIPT = `Discovery call with Bright Smile Dental. ${"They want an after-hours voice agent that books appointments. ".repeat(4)}`;

let harness: IntakeHarness;

beforeAll(async () => {
  harness = await createIntakeHarness();
  h.orgId.value = harness.orgId;
});

afterEach(async () => {
  h.parseMock.mockReset();
  await clearAgentRuns(harness.orgId);
});

afterAll(async () => {
  await cleanupIntakeHarness(harness);
});

describe("POST /api/projects/intake", () => {
  it("returns a draft + runId on the happy path", async () => {
    h.parseMock.mockResolvedValueOnce(parseOk(makeDraft()));
    const res = await intakePOST(intakeReq({ transcript: TRANSCRIPT }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as DraftEnvelope;
    expect(json.draft.name).toBe("Reception voice agent");
    expect(json.draft.type).toBe("voice_agent");
    expect(typeof json.runId).toBe("string");
  });

  it("400s a transcript below the character floor", async () => {
    const res = await intakePOST(intakeReq({ transcript: "too short" }));
    expect(res.status).toBe(400);
    expect(h.parseMock).not.toHaveBeenCalled();
  });

  it("coerces an unknown existing clientId back to a new client", async () => {
    h.parseMock.mockResolvedValueOnce(
      parseOk(
        makeDraft({
          client: {
            match: "existing",
            clientId: randomUUID(),
            name: "Ghost Client",
            industrySlug: null,
          },
        }),
      ),
    );
    const res = await intakePOST(intakeReq({ transcript: TRANSCRIPT }));
    const json = (await res.json()) as DraftEnvelope;
    expect(json.draft.client.match).toBe("new");
    expect(json.draft.client.clientId).toBeNull();
  });

  it("keeps a real existing client from the org's list", async () => {
    h.parseMock.mockResolvedValueOnce(
      parseOk(
        makeDraft({
          client: {
            match: "existing",
            clientId: harness.clientId,
            name: harness.clientName,
            industrySlug: null,
          },
        }),
      ),
    );
    const res = await intakePOST(intakeReq({ transcript: TRANSCRIPT }));
    const json = (await res.json()) as DraftEnvelope;
    expect(json.draft.client.match).toBe("existing");
    expect(json.draft.client.clientId).toBe(harness.clientId);
  });

  it("502s intake_parse_failed when parsed_output is null", async () => {
    h.parseMock.mockResolvedValueOnce({
      parsed_output: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const res = await intakePOST(intakeReq({ transcript: TRANSCRIPT }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorEnvelope).error).toBe("intake_parse_failed");
  });

  it("maps an Anthropic auth error to 502 anthropic_auth", async () => {
    h.parseMock.mockRejectedValueOnce(
      new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers()),
    );
    const res = await intakePOST(intakeReq({ transcript: TRANSCRIPT }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorEnvelope).error).toBe("anthropic_auth");
  });

  it("maps a rate-limit error to 429 anthropic_rate_limited", async () => {
    h.parseMock.mockRejectedValueOnce(
      new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()),
    );
    const res = await intakePOST(intakeReq({ transcript: TRANSCRIPT }));
    expect(res.status).toBe(429);
    expect(((await res.json()) as ErrorEnvelope).error).toBe("anthropic_rate_limited");
  });

  it("writes an agent_runs row with tokens + model on success", async () => {
    h.parseMock.mockResolvedValueOnce(parseOk(makeDraft(), 1500, 450));
    const res = await intakePOST(intakeReq({ transcript: TRANSCRIPT }));
    const json = (await res.json()) as DraftEnvelope;

    const rows = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.orgId, harness.orgId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(json.runId);
    expect(row.agent).toBe("project_intake");
    expect(row.status).toBe("succeeded");
    expect(row.model).toBe(AGENT_MODEL);
    expect(row.tokensIn).toBe(1500);
    expect(row.tokensOut).toBe(450);
    expect(row.finishedAt).not.toBeNull();
    expect(row.outputRefs).toMatchObject({ mode: "intake" });
    // Intake predates the project — unattributed until /intake/attribute runs.
    expect(row.projectId).toBeNull();
    expect(row.clientId).toBeNull();
  });
});

describe("POST /api/projects/intake/refine", () => {
  it("returns the full updated draft plus a note", async () => {
    const refined = makeDraft({ retainerPenceMonthly: 200_000 });
    h.parseMock.mockResolvedValueOnce(
      parseOk({ draft: refined, note: "Set the retainer to £2,000/mo." }, 800, 220),
    );
    const res = await refinePOST(
      refineReq({
        draft: makeDraft(),
        instruction: "set the retainer to £2000 a month",
        transcript: TRANSCRIPT,
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as RefineEnvelope;
    expect(json.draft.retainerPenceMonthly).toBe(200_000);
    expect(json.note).toContain("2,000");
    expect(typeof json.runId).toBe("string");

    const rows = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.orgId, harness.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outputRefs).toMatchObject({ mode: "refine" });
  });

  it("400s an empty instruction", async () => {
    const res = await refinePOST(
      refineReq({ draft: makeDraft(), instruction: "" }),
    );
    expect(res.status).toBe(400);
    expect(h.parseMock).not.toHaveBeenCalled();
  });
});

describe("runIntakeAgent", () => {
  it("writes projectId/clientId onto the agent_runs row when provided", async () => {
    h.parseMock.mockResolvedValueOnce(parseOk(makeDraft()));
    const result = await runIntakeAgent({
      orgId: harness.orgId,
      projectId: harness.projectId,
      clientId: harness.clientId,
      system: "test system",
      userContent: "test user content",
      schema: projectDraftSchema,
      mode: "intake",
    });
    if (!result.ok) throw new Error(`run failed: ${result.error}`);

    const rows = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.orgId, harness.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(result.runId);
    expect(rows[0]!.projectId).toBe(harness.projectId);
    expect(rows[0]!.clientId).toBe(harness.clientId);
  });
});
