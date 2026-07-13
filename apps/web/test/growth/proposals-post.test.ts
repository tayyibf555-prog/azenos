import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "@azen/db";

/**
 * POST /api/growth/proposals (docs/phase6/CONTRACTS.md §P6-GROWTH). The Upsell
 * Engine is MOCKED at the @azen/agents boundary (no live model call); we assert
 * the route wires it correctly: a successful run returns the proposal id, a
 * no-eligible-opportunity result maps to 404, a typed anthropic_auth error maps
 * to 502, a budget halt maps to 402, and a bodyless request is a 400.
 */

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());
const hoisted = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

vi.mock("@azen/agents", () => ({
  runUpsellEngine: hoisted.runMock,
}));

import { POST } from "../../app/api/growth/proposals/route";

function postReq(body: unknown): Request {
  return new Request("http://t/api/growth/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  hoisted.runMock.mockReset();
});

afterAll(async () => {
  await closeDb();
});

describe("POST /api/growth/proposals", () => {
  it("runs the Upsell Engine for an insight and returns the proposal id", async () => {
    const proposalId = randomUUID();
    const insightId = randomUUID();
    hoisted.runMock.mockResolvedValueOnce({
      ok: true,
      proposalId,
      insightIds: [insightId],
      clientId: randomUUID(),
      tokensIn: 10,
      tokensOut: 5,
    });

    const res = await POST(postReq({ insightId }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { proposalId: string; insightIds: string[] };
    expect(json.proposalId).toBe(proposalId);
    expect(json.insightIds).toEqual([insightId]);
    // the route forwarded the org + insight to the engine
    expect(hoisted.runMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: TEST_ORG_ID, insightId }),
    );
  });

  it("maps a no-eligible-opportunity result to 404", async () => {
    hoisted.runMock.mockResolvedValueOnce({
      ok: true,
      proposalId: null,
      insightIds: [],
      clientId: null,
      tokensIn: 0,
      tokensOut: 0,
    });
    const res = await POST(postReq({ clientId: randomUUID() }));
    expect(res.status).toBe(404);
  });

  it("maps a typed anthropic_auth error to 502", async () => {
    hoisted.runMock.mockResolvedValueOnce({ ok: false, error: "anthropic_auth" });
    const res = await POST(postReq({ insightId: randomUUID() }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("anthropic_auth");
  });

  it("maps a budget halt to 402", async () => {
    hoisted.runMock.mockResolvedValueOnce({ ok: false, error: "budget_exceeded" });
    const res = await POST(postReq({ insightId: randomUUID() }));
    expect(res.status).toBe(402);
  });

  it("rejects a request with neither insightId nor clientId (400)", async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    expect(hoisted.runMock).not.toHaveBeenCalled();
  });
});
