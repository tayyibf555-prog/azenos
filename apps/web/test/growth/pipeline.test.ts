import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, db, insights, upsellProposals } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
} from "../metrics-api/helpers";

/**
 * Growth pipeline + won-revenue attribution + proposal status transitions
 * (docs/phase6/CONTRACTS.md §P6-GROWTH). A real throwaway-org DB backs the
 * queries; requireOrgId is mocked to the throwaway org. We hand-build insights
 * and proposals, then assert: the pipeline shows only in-play opportunity/upsell
 * insights (new | reviewed), the summary attributes WON proposals' prices as OS
 * revenue, and the PATCH route walks a proposal draft → ready → sent → won.
 */

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import {
  getGrowthPipeline,
  getGrowthProposals,
  getGrowthSummary,
} from "../../lib/server/growth";
import { PATCH } from "../../app/api/growth/proposals/[id]/route";

let clientId: string;
let projectId: string;

async function insertInsight(opts: {
  kind: "automation_opportunity" | "upsell" | "anomaly";
  status: "new" | "reviewed" | "dismissed" | "converted_to_upsell";
  title: string;
  valuePence?: number;
  confidence?: "low" | "med" | "high";
  eventIds?: string[];
}): Promise<string> {
  const id = randomUUID();
  await db.insert(insights).values({
    id,
    orgId: TEST_ORG_ID,
    projectId,
    kind: opts.kind,
    title: opts.title,
    bodyMd: opts.title,
    evidence: opts.eventIds ? { event_ids: opts.eventIds } : {},
    estimatedValuePence: opts.valuePence ?? null,
    confidence: opts.confidence ?? "med",
    status: opts.status,
    createdBy: "agent",
  });
  return id;
}

async function insertProposal(opts: {
  status: "draft" | "ready" | "sent" | "won" | "lost";
  pricePence: number;
  title?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(upsellProposals).values({
    id,
    orgId: TEST_ORG_ID,
    clientId,
    projectId,
    title: opts.title ?? "Proposal",
    problemMd: "problem",
    proposalMd: "proposal",
    evidence: {},
    suggestedPricePence: opts.pricePence,
    status: opts.status,
    insightIds: [],
  });
  return id;
}

async function clearRows(): Promise<void> {
  await db.$client`delete from upsell_proposals where org_id = ${TEST_ORG_ID}::uuid`;
  await db.$client`delete from insights where org_id = ${TEST_ORG_ID}::uuid`;
}

function patchReq(status: string): Request {
  return new Request("http://t/api/growth/proposals/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId);
});

beforeEach(async () => {
  await clearRows();
});

afterAll(async () => {
  await clearRows();
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

describe("getGrowthPipeline — only in-play opportunities", () => {
  it("includes new/reviewed opportunity+upsell insights, excludes converted/dismissed/other kinds", async () => {
    const a = await insertInsight({
      kind: "automation_opportunity",
      status: "new",
      title: "New opp",
      valuePence: 120_000,
    });
    const b = await insertInsight({
      kind: "automation_opportunity",
      status: "reviewed",
      title: "Reviewed opp",
      valuePence: 90_000,
    });
    const c = await insertInsight({ kind: "upsell", status: "new", title: "Upsell" });
    // excluded:
    await insertInsight({
      kind: "automation_opportunity",
      status: "converted_to_upsell",
      title: "Converted",
    });
    await insertInsight({
      kind: "automation_opportunity",
      status: "dismissed",
      title: "Dismissed",
    });
    await insertInsight({ kind: "anomaly", status: "new", title: "Anomaly" });

    const pipeline = await getGrowthPipeline(TEST_ORG_ID);
    const ids = pipeline.map((p) => p.id).sort();
    expect(ids).toEqual([a, b, c].sort());
    // highest estimated value first
    expect(pipeline[0]!.id).toBe(a);
    // client + project names hydrated
    expect(pipeline[0]!.clientName).toBeTruthy();
    expect(pipeline[0]!.projectName).toBeTruthy();
  });

  it("reports a cited-evidence count from the insight evidence", async () => {
    await insertInsight({
      kind: "automation_opportunity",
      status: "new",
      title: "With evidence",
      eventIds: [randomUUID(), randomUUID()],
    });
    const pipeline = await getGrowthPipeline(TEST_ORG_ID);
    expect(pipeline[0]!.evidenceEventCount).toBe(2);
  });
});

describe("getGrowthSummary — OS-attributed won revenue", () => {
  it("sums only WON proposals' suggested prices and counts the funnel", async () => {
    await insertProposal({ status: "won", pricePence: 90_000 });
    await insertProposal({ status: "won", pricePence: 60_000 });
    await insertProposal({ status: "sent", pricePence: 30_000 });
    await insertProposal({ status: "draft", pricePence: 20_000 });
    await insertProposal({ status: "lost", pricePence: 99_000 });
    await insertInsight({
      kind: "automation_opportunity",
      status: "new",
      title: "Open opp",
    });

    const s = await getGrowthSummary(TEST_ORG_ID);
    // 90_000 + 60_000 = 150_000; lost/sent/draft excluded from won revenue
    expect(s.wonRevenuePence).toBe(150_000);
    expect(s.wonCount).toBe(2);
    // draft + sent are "in flight" (lost/won excluded)
    expect(s.openProposals).toBe(2);
    expect(s.openOpportunities).toBe(1);
  });
});

describe("PATCH /api/growth/proposals/[id] — status transitions", () => {
  it("walks a proposal draft → ready → sent → won", async () => {
    const id = await insertProposal({ status: "draft", pricePence: 50_000 });

    for (const status of ["ready", "sent", "won"] as const) {
      const res = await PATCH(patchReq(status), {
        params: Promise.resolve({ id }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { proposal: { status: string } };
      expect(json.proposal.status).toBe(status);
    }

    // won revenue now reflects the transition
    const s = await getGrowthSummary(TEST_ORG_ID);
    expect(s.wonRevenuePence).toBe(50_000);
    const proposals = await getGrowthProposals(TEST_ORG_ID);
    expect(proposals[0]!.status).toBe("won");
  });

  it("can mark a proposal lost", async () => {
    const id = await insertProposal({ status: "sent", pricePence: 40_000 });
    const res = await PATCH(patchReq("lost"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const s = await getGrowthSummary(TEST_ORG_ID);
    expect(s.wonRevenuePence).toBe(0);
  });

  it("rejects an unknown status (400) and an unknown id (404)", async () => {
    const bad = await PATCH(patchReq("archived"), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    expect(bad.status).toBe(400);

    const missing = await PATCH(patchReq("won"), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    expect(missing.status).toBe(404);
  });
});
