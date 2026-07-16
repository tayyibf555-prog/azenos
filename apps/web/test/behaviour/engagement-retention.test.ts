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
import type { EngagementData } from "../../app/api/projects/[projectId]/analytics/engagement/route";

/**
 * P9-PACK2 — Engagement additive blocks: retention cohorts (8×8 triangle,
 * fixed 8-block lookback ending "today", independent of `?range=`) +
 * channel-shift (this window vs the prior equal window). Every number is
 * hand-computed in the comments below against the block-index formula the
 * route uses: block i covers daysAgo range [(7-i)*7, (7-i)*7+6] — i=7 is
 * "this week" (daysAgo 0-6), i=0 is 7 blocks earlier (daysAgo 49-55).
 */

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET } from "../../app/api/projects/[projectId]/analytics/engagement/route";

let projectId: string;
let emptyProjectId: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId, { name: "Retention Fixture" });
  emptyProjectId = await createProject(TEST_ORG_ID, clientId, { name: "Retention Empty" });

  const noSubject = { type: "custom.cohort_marker" as const };

  // ── cohort @ block 2 (daysAgo 35-41): u1, u2, first-seen daysAgo 38 ────────
  // u1 also active in block 6 (daysAgo 10) → offset 4. u2 has no later activity.
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    ...noSubject,
    subjectId: "u1",
    occurredAt: noonOnDaysAgo(38),
  });
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    ...noSubject,
    subjectId: "u1",
    occurredAt: noonOnDaysAgo(10),
  });
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    ...noSubject,
    subjectId: "u2",
    occurredAt: noonOnDaysAgo(38),
  });

  // ── cohort @ block 4 (daysAgo 21-27): s1..s5, first-seen daysAgo 25 ────────
  // s2 also active block5 (daysAgo17, offset1); s3 active block5+block6
  // (offsets 1,2); s4 active block7 (daysAgo3, offset3); s1/s5 offset0 only.
  for (const [sid, extraDaysAgo] of [
    ["s1", []],
    ["s2", [17]],
    ["s3", [17, 10]],
    ["s4", [3]],
    ["s5", []],
  ] as [string, number[]][]) {
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      ...noSubject,
      subjectId: sid,
      occurredAt: noonOnDaysAgo(25),
    });
    for (const d of extraDaysAgo) {
      await insertBehaviourEvent(TEST_ORG_ID, projectId, {
        ...noSubject,
        subjectId: sid,
        occurredAt: noonOnDaysAgo(d),
      });
    }
  }

  // ── cohort @ block 6 (daysAgo 7-13): t1..t3, first-seen daysAgo 10 ─────────
  // t2/t3 also active block7 (offset1); t1 offset0 only. Block 6's own max
  // offset is 7-6=1, so this exercises the triangle's tight upper bound.
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    ...noSubject,
    subjectId: "t1",
    occurredAt: noonOnDaysAgo(10),
  });
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    ...noSubject,
    subjectId: "t2",
    occurredAt: noonOnDaysAgo(10),
  });
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    ...noSubject,
    subjectId: "t2",
    occurredAt: noonOnDaysAgo(2),
  });
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    ...noSubject,
    subjectId: "t3",
    occurredAt: noonOnDaysAgo(10),
  });
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    ...noSubject,
    subjectId: "t3",
    occurredAt: noonOnDaysAgo(4),
  });

  // ── prehistoric subject: first-seen far outside the 8-block window ────────
  // (daysAgo 200) but WITH an event inside block 7 (daysAgo 3). Regression
  // guard: must contribute to no cohort at all (its "first seen" block never
  // matches any of the 8 tracked blocks), so it must not inflate block 7's
  // activity count for any real cohort above.
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    ...noSubject,
    subjectId: "prehistoric",
    occurredAt: noonOnDaysAgo(200),
  });
  await insertBehaviourEvent(TEST_ORG_ID, projectId, {
    ...noSubject,
    subjectId: "prehistoric",
    occurredAt: noonOnDaysAgo(3),
  });

  // ── channel-shift: current 30d window (daysAgo 0-29) vs prior (30-59) ──────
  // No `subject` on these — they must not leak into the retention cohorts
  // above. Current: 6 "chat" + 2 "voice" (75%/25%). Prior: 2 "chat" + 6
  // "voice" (25%/75%) — a clean chat-up/voice-down shift.
  for (const d of [5, 6, 7, 8, 9, 10]) {
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "llm.conversation",
      occurredAt: noonOnDaysAgo(d),
      data: { channel: "chat" },
    });
  }
  for (const d of [3, 4]) {
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "call.completed",
      occurredAt: noonOnDaysAgo(d),
      data: { direction: "inbound" },
    });
  }
  for (const d of [35, 36]) {
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "llm.conversation",
      occurredAt: noonOnDaysAgo(d),
      data: { channel: "chat" },
    });
  }
  for (const d of [40, 41, 42, 43, 44, 45]) {
    await insertBehaviourEvent(TEST_ORG_ID, projectId, {
      type: "call.completed",
      occurredAt: noonOnDaysAgo(d),
      data: { direction: "inbound" },
    });
  }
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

async function getEngagement(pid: string, range = "30d"): Promise<EngagementData> {
  const res = await GET(new Request(`http://t/api?range=${range}`), {
    params: Promise.resolve({ projectId: pid }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as EngagementData;
}

describe("GET /api/projects/[projectId]/analytics/engagement — retention cohorts", () => {
  it("builds the exact 8×8 triangle from hand-built cohorts", async () => {
    const body = await getEngagement(projectId);

    // Only blocks with a nonzero cohort appear (2, 4, 6) — prehistoric's
    // out-of-window first-seen never creates a spurious 4th cohort.
    expect(body.retentionCohorts.map((c) => c.block)).toEqual([2, 4, 6]);

    const byBlock = Object.fromEntries(body.retentionCohorts.map((c) => [c.block, c]));

    expect(byBlock[2]!.cohortSize).toBe(2);
    expect(byBlock[2]!.cells).toEqual(
      expect.arrayContaining([
        { offset: 0, activeCount: 2, activePct: 100 },
        { offset: 4, activeCount: 1, activePct: 50 },
      ]),
    );
    expect(byBlock[2]!.cells).toHaveLength(2);

    expect(byBlock[4]!.cohortSize).toBe(5);
    expect(byBlock[4]!.cells).toEqual(
      expect.arrayContaining([
        { offset: 0, activeCount: 5, activePct: 100 },
        { offset: 1, activeCount: 2, activePct: 40 },
        { offset: 2, activeCount: 1, activePct: 20 },
        { offset: 3, activeCount: 1, activePct: 20 },
      ]),
    );
    expect(byBlock[4]!.cells).toHaveLength(4);

    expect(byBlock[6]!.cohortSize).toBe(3);
    expect(byBlock[6]!.cells).toEqual(
      expect.arrayContaining([
        { offset: 0, activeCount: 3, activePct: 100 },
        { offset: 1, activeCount: 2, activePct: 66.7 },
      ]),
    );
    expect(byBlock[6]!.cells).toHaveLength(2);
  });

  it("computes the weighted week-1 and week-4 retention headline numbers", async () => {
    const body = await getEngagement(projectId);
    // week1 (offset=1, cohorts with block <= 6 → blocks 2,4,6 all qualify):
    //   numerator = block2's offset1 (0, absent) + block4's (2) + block6's (2) = 4
    //   denominator = 2 + 5 + 3 = 10 → 40.0%
    expect(body.retentionWeek1Pct).toBe(40);
    // week4 (offset=4, cohorts with block <= 3 → only block2 qualifies):
    //   numerator = block2's offset4 (1); denominator = block2's size (2) → 50.0%
    expect(body.retentionWeek4Pct).toBe(50);
  });

  it("degrades to empty cohorts and null retention on a project with no subjects", async () => {
    const body = await getEngagement(emptyProjectId);
    expect(body.retentionCohorts).toEqual([]);
    expect(body.retentionWeek1Pct).toBeNull();
    expect(body.retentionWeek4Pct).toBeNull();
  });
});

describe("GET /api/projects/[projectId]/analytics/engagement — channel shift", () => {
  it("computes current vs prior share and the percentage-point delta exactly", async () => {
    const body = await getEngagement(projectId);
    const byLabel = Object.fromEntries(body.channelShift.map((c) => [c.label, c]));

    expect(byLabel["chat"]).toEqual({ label: "chat", currentPct: 75, priorPct: 25, deltaPct: 50 });
    expect(byLabel["voice"]).toEqual({ label: "voice", currentPct: 25, priorPct: 75, deltaPct: -50 });
  });

  it("returns no rows for a project with no channelled activity", async () => {
    const body = await getEngagement(emptyProjectId);
    expect(body.channelShift).toEqual([]);
  });
});
