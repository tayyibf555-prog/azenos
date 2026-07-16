import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, db, shareTokens, upsellProposals } from "@azen/db";
import { cleanupOrg, createClient, createOrg, createProject } from "../metrics-api/helpers";

/**
 * §P8-GROWTH2 — "Send" a proposal + track views (docs/phase8/CONTRACTS.md).
 * A real throwaway-org DB backs every query; requireOrgId is mocked for the
 * route test. DEMO_ORG_ID is never touched (ground rules).
 */

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import {
  getGrowthProposals,
  loadSharedProposal,
  sendProposal,
} from "../../lib/server/growth";
import { recordView, resolveShareToken } from "../../lib/server/share";
import { ProposalDoc } from "../../app/share/[token]/ProposalDoc";
import { POST } from "../../app/api/growth/proposals/[id]/send/route";

let clientId: string;
let projectId: string;

async function insertProposal(opts: {
  status: "draft" | "ready" | "sent" | "won" | "lost";
  pricePence?: number | null;
  title?: string;
  orgId?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(upsellProposals).values({
    id,
    orgId: opts.orgId ?? TEST_ORG_ID,
    clientId,
    projectId,
    title: opts.title ?? "Add a booking follow-up agent",
    problemMd: "The front desk misses ~30% of after-hours enquiries.",
    proposalMd: "We'd add a follow-up agent that texts back within a minute.",
    evidence: {},
    suggestedPricePence: opts.pricePence ?? 150_000,
    status: opts.status,
    insightIds: [],
  });
  return id;
}

async function clearRows(orgId: string): Promise<void> {
  await db.delete(shareTokens).where(eq(shareTokens.orgId, orgId));
  await db.delete(upsellProposals).where(eq(upsellProposals.orgId, orgId));
}

function sendReq(id: string): Request {
  return new Request(`http://t/api/growth/proposals/${id}/send`, { method: "POST" });
}

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId);
});

beforeEach(async () => {
  await clearRows(TEST_ORG_ID);
});

afterAll(async () => {
  await clearRows(TEST_ORG_ID);
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

describe("sendProposal — mints a share token and flips status", () => {
  it("sends a 'ready' proposal: high-entropy token, status → sent", async () => {
    const id = await insertProposal({ status: "ready" });

    const result = await sendProposal(TEST_ORG_ID, id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.status).toBe("sent");
    expect(result.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.token.length).toBeGreaterThanOrEqual(43);

    const proposals = await getGrowthProposals(TEST_ORG_ID);
    const sent = proposals.find((p) => p.id === id);
    expect(sent?.status).toBe("sent");
    expect(sent?.viewCount).toBe(0);
  });

  it("is race-safe: two concurrent sends of one 'ready' proposal mint ONE token", async () => {
    // The old read-then-write flow let both sends pass a `status === 'ready'`
    // guard, so both minted a token (no unique constraint on proposal_id) and
    // both flipped status. The guard now lives in the UPDATE's WHERE, so exactly
    // one send claims the row — the other sees 'sent' and gets invalid_status.
    const id = await insertProposal({ status: "ready" });

    const [a, b] = await Promise.all([
      sendProposal(TEST_ORG_ID, id),
      sendProposal(TEST_ORG_ID, id),
    ]);

    const okResults = [a, b].filter((r) => r.ok);
    expect(okResults).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok);
    if (loser && !loser.ok) expect(loser.error).toBe("invalid_status");

    // Exactly one live proposal token exists for the proposal.
    const tokens = await db
      .select({ id: shareTokens.id })
      .from(shareTokens)
      .where(eq(shareTokens.proposalId, id));
    expect(tokens).toHaveLength(1);
  });

  it("refuses to send a proposal that isn't 'ready'", async () => {
    const draftId = await insertProposal({ status: "draft" });
    const wonId = await insertProposal({ status: "won" });

    for (const id of [draftId, wonId]) {
      const result = await sendProposal(TEST_ORG_ID, id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("invalid_status");
    }
  });

  it("returns not_found for an unknown or cross-org proposal id", async () => {
    const missing = await sendProposal(TEST_ORG_ID, randomUUID());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe("not_found");

    const strangerOrgId = randomUUID();
    await createOrg(strangerOrgId);
    const strangerClientId = await createClient(strangerOrgId);
    const strangerProjectId = await createProject(strangerOrgId, strangerClientId);
    const strangerProposalId = randomUUID();
    await db.insert(upsellProposals).values({
      id: strangerProposalId,
      orgId: strangerOrgId,
      clientId: strangerClientId,
      projectId: strangerProjectId,
      title: "Stranger's proposal",
      problemMd: "x",
      proposalMd: "y",
      evidence: {},
      suggestedPricePence: 10_000,
      status: "ready",
      insightIds: [],
    });

    try {
      const crossOrg = await sendProposal(TEST_ORG_ID, strangerProposalId);
      expect(crossOrg.ok).toBe(false);
      if (!crossOrg.ok) expect(crossOrg.error).toBe("not_found");
    } finally {
      await clearRows(strangerOrgId);
      await cleanupOrg(strangerOrgId);
    }
  });

  it("surfaces 'viewed Nx · last seen' stats once the link is opened", async () => {
    const id = await insertProposal({ status: "ready" });
    const sent = await sendProposal(TEST_ORG_ID, id);
    if (!sent.ok) throw new Error("send failed");

    const resolved = await resolveShareToken(sent.token);
    expect(resolved).not.toBeNull();
    expect(resolved?.kind).toBe("proposal");
    await recordView(resolved!.id);
    await recordView(resolved!.id);

    const proposals = await getGrowthProposals(TEST_ORG_ID);
    const viewed = proposals.find((p) => p.id === id);
    expect(viewed?.viewCount).toBe(2);
    expect(viewed?.lastViewedAt).not.toBeNull();
  });

  it("loads a white-label proposal doc that leaks no org id or raw token", async () => {
    const id = await insertProposal({ status: "ready", title: "Reception follow-up agent" });
    const sent = await sendProposal(TEST_ORG_ID, id);
    if (!sent.ok) throw new Error("send failed");

    const resolved = await resolveShareToken(sent.token);
    const doc = await loadSharedProposal(resolved!);
    expect(doc).not.toBeNull();
    expect(doc?.title).toBe("Reception follow-up agent");

    const html = renderToStaticMarkup(ProposalDoc({ proposal: doc! }));
    expect(html).not.toContain(TEST_ORG_ID);
    expect(html).not.toContain(sent.token);
    expect(html).toContain("Reception follow-up agent");
  });
});

describe("POST /api/growth/proposals/[id]/send — route mapping", () => {
  it("200s a ready proposal with the token + new status", async () => {
    const id = await insertProposal({ status: "ready" });
    const res = await POST(sendReq(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { proposal: { status: string }; token: string };
    expect(json.proposal.status).toBe("sent");
    expect(typeof json.token).toBe("string");
  });

  it("409s a non-ready proposal", async () => {
    const id = await insertProposal({ status: "draft" });
    const res = await POST(sendReq(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
  });

  it("404s an unknown id", async () => {
    const res = await POST(sendReq(randomUUID()), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    expect(res.status).toBe(404);
  });
});
