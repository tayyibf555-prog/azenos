import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  noonOnDaysAgo,
} from "../metrics-api/helpers";
import { addHours, insertBehaviourEvent } from "./helpers";
import type { FunnelData } from "../../app/api/projects/[projectId]/analytics/funnel/route";

/**
 * P9-PACK2 — Funnel additive blocks: REAL stage-to-stage time percentiles
 * (percentile_cont, matched by subject id across adjacent stages — distinct
 * from the pre-existing `avgLagHoursFromPrev` structural mean-time proxy) +
 * a drop-off-reasons hint (top intents of abandoned conversations).
 *
 * percentile_cont(p) on N sorted values uses linear-interpolation rank
 * = p * (N-1) (0-indexed); every fixture below is hand-picked so that rank
 * lands on an exact or half/tenth step, and every expected value is computed
 * in the comments.
 */

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET } from "../../app/api/projects/[projectId]/analytics/funnel/route";

let projectId: string;
let emptyProjectId: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId, { name: "Funnel Percentiles Fixture" });
  emptyProjectId = await createProject(TEST_ORG_ID, clientId, { name: "Funnel Percentiles Empty" });

  const base = noonOnDaysAgo(10);

  // ── gap 1 · leads → qualified: 3 subjects, deltas [1h, 2h, 3h] ─────────────
  // sorted=[1,2,3]; p50 rank=0.5*2=1 → 2h; p90 rank=0.9*2=1.8 → 2+0.8*(3-2)=2.8h
  for (const [sid, delta] of [
    ["g1a", 1],
    ["g1b", 2],
    ["g1c", 3],
  ] as [string, number][]) {
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "lead.created",
      subjectId: sid,
      occurredAt: base,
    });
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "lead.qualified",
      subjectId: sid,
      occurredAt: addHours(base, delta),
    });
  }

  // ── regression guard: a subject-less pair must NOT enter the sample ───────
  // (if the subject-null guard broke, this 100h delta would blow the numbers
  // above wide open — sampleSize would be 4 and p50/p90 would shift hard).
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    type: "lead.created",
    occurredAt: base,
  });
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    type: "lead.qualified",
    occurredAt: addHours(base, 100),
  });

  // ── negative-delta guard: qualified BEFORE lead must be excluded ──────────
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    type: "lead.created",
    subjectId: "gNeg",
    occurredAt: addHours(base, 5),
  });
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    type: "lead.qualified",
    subjectId: "gNeg",
    occurredAt: base,
  });

  // ── gap 2 · qualified → booked: 2 subjects, deltas [4h, 8h] ────────────────
  // sorted=[4,8]; p50 rank=0.5 → 4+0.5*4=6h; p90 rank=0.9 → 4+0.9*4=7.6h
  for (const [sid, delta] of [
    ["g2a", 4],
    ["g2b", 8],
  ] as [string, number][]) {
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "lead.qualified",
      subjectId: sid,
      occurredAt: base,
    });
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "booking.created",
      subjectId: sid,
      occurredAt: addHours(base, delta),
    });
  }

  // ── gap 3 · booked → attended: 4 subjects, deltas [1h, 2h, 3h, 4h] ─────────
  // sorted=[1,2,3,4]; p50 rank=1.5 → 2+0.5*1=2.5h; p90 rank=2.7 → 3+0.7*1=3.7h
  for (const [sid, delta] of [
    ["g3a", 1],
    ["g3b", 2],
    ["g3c", 3],
    ["g3d", 4],
  ] as [string, number][]) {
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "booking.created",
      subjectId: sid,
      occurredAt: base,
    });
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "booking.completed",
      subjectId: sid,
      occurredAt: addHours(base, delta),
    });
  }

  // ── gap 4 · attended → paid: 1 subject, delta 5h (single-value percentile) ─
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    type: "booking.completed",
    subjectId: "g4a",
    occurredAt: base,
  });
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    type: "payment.captured",
    subjectId: "g4a",
    occurredAt: addHours(base, 5),
  });

  // ── drop-off reasons: abandoned conversations by intent ────────────────────
  const abandonedBase = noonOnDaysAgo(5);
  for (const intent of ["pricing", "pricing", "pricing", "scheduling", "scheduling", "onboarding"]) {
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "llm.conversation",
      occurredAt: abandonedBase,
      data: { resolution: "abandoned", intent },
    });
  }
  // resolved conversation with the same intent must NOT count as a drop-off.
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    type: "llm.conversation",
    occurredAt: abandonedBase,
    data: { resolution: "resolved", intent: "pricing" },
  });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

async function getFunnel(pid: string): Promise<FunnelData> {
  const res = await GET(new Request("http://t/api?range=30d"), {
    params: Promise.resolve({ projectId: pid }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as FunnelData;
}

describe("GET /api/projects/[projectId]/analytics/funnel — stage percentiles", () => {
  it("computes real per-entity p50/p90 for every adjacent stage gap", async () => {
    const body = await getFunnel(projectId);
    const byKey = Object.fromEntries(body.stagePercentiles.map((r) => [r.key, r]));

    expect(byKey["leads_qualified"]).toMatchObject({ sampleSize: 3, p50Hours: 2, p90Hours: 2.8 });
    expect(byKey["qualified_booked"]).toMatchObject({ sampleSize: 2, p50Hours: 6, p90Hours: 7.6 });
    expect(byKey["booked_completed"]).toMatchObject({ sampleSize: 4, p50Hours: 2.5, p90Hours: 3.7 });
    expect(byKey["completed_paid"]).toMatchObject({ sampleSize: 1, p50Hours: 5, p90Hours: 5 });
  });

  it("degrades to null percentiles / zero sample on an empty project", async () => {
    const body = await getFunnel(emptyProjectId);
    for (const row of body.stagePercentiles) {
      expect(row.sampleSize).toBe(0);
      expect(row.p50Hours).toBeNull();
      expect(row.p90Hours).toBeNull();
    }
  });
});

describe("GET /api/projects/[projectId]/analytics/funnel — drop-off reasons", () => {
  it("ranks abandoned-conversation intents, excluding resolved ones", async () => {
    const body = await getFunnel(projectId);
    expect(body.abandonedIntents).toEqual([
      { label: "pricing", value: 3 },
      { label: "scheduling", value: 2 },
      { label: "onboarding", value: 1 },
    ]);
  });

  it("returns an empty list when nothing abandoned", async () => {
    const body = await getFunnel(emptyProjectId);
    expect(body.abandonedIntents).toEqual([]);
  });
});
