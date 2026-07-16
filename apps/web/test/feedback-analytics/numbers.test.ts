import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  noonOnDaysAgo,
} from "../metrics-api/helpers";
import { cleanupFeedbackAnalytics, insertFeedbackItem } from "./helpers";
import type { FeedbackData } from "../../components/analytics/sections/FeedbackSection";

/**
 * Feedback analytics numbers vs hand-built rows (docs/phase7/PLAN.md §B2).
 * A 30d-range project with 5 in-range items + 1 prior-period item (day-40) so
 * every range-scoped number (total / prevTotal / kindMix / severityMix) AND
 * every live all-time number (statusCounts / resolution / board / recentItems
 * / submitterLeaderboard) is hand-computed and checked exactly.
 */

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET as feedbackGET } from "../../app/api/projects/[projectId]/analytics/feedback/route";

let projectId: string;
let emptyProjectId: string;

// item ids, named for readability in expectations below
let itemBugBlocking: string; // day-5, bug, sev 3, new, "Ada Lovelace"
let itemBugMinor: string; // day-3, bug, sev 1, seen, bob@x.com
let itemFeature: string; // day-10, feature, planned, anonymous
let itemPraise: string; // day-1, praise, done, "Ada Lovelace"
let itemQuestion: string; // day-20, question, new, anonymous
let itemPrevPeriod: string; // day-40 (prior period), bug, done, anonymous

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId, { name: "Feedback Numbers" });
  emptyProjectId = await createProject(TEST_ORG_ID, clientId, { name: "Feedback Empty" });

  itemBugBlocking = await insertFeedbackItem(TEST_ORG_ID, projectId, {
    kind: "bug",
    severity: 3,
    status: "new",
    submitterName: "Ada Lovelace",
    createdAt: noonOnDaysAgo(5),
  });
  itemBugMinor = await insertFeedbackItem(TEST_ORG_ID, projectId, {
    kind: "bug",
    severity: 1,
    status: "seen",
    submitterEmail: "bob@x.com",
    createdAt: noonOnDaysAgo(3),
  });
  itemFeature = await insertFeedbackItem(TEST_ORG_ID, projectId, {
    kind: "feature",
    status: "planned",
    createdAt: noonOnDaysAgo(10),
  });
  itemPraise = await insertFeedbackItem(TEST_ORG_ID, projectId, {
    kind: "praise",
    status: "done",
    submitterName: "Ada Lovelace",
    createdAt: noonOnDaysAgo(1),
  });
  itemQuestion = await insertFeedbackItem(TEST_ORG_ID, projectId, {
    kind: "question",
    status: "new",
    createdAt: noonOnDaysAgo(20),
  });
  // Outside the 30d range (falls in the immediately-preceding 30d period).
  itemPrevPeriod = await insertFeedbackItem(TEST_ORG_ID, projectId, {
    kind: "bug",
    status: "done",
    createdAt: noonOnDaysAgo(40),
  });
});

afterAll(async () => {
  await cleanupFeedbackAnalytics(TEST_ORG_ID);
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

async function getFeedback(pid: string, range = "30d"): Promise<FeedbackData> {
  const res = await feedbackGET(
    new Request(`http://t/api?range=${range}`),
    { params: Promise.resolve({ projectId: pid }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as FeedbackData;
}

describe("GET /api/projects/[projectId]/analytics/feedback", () => {
  it("computes range-scoped totals, kind mix and severity mix exactly", async () => {
    const body = await getFeedback(projectId);

    // 5 items inside [today-29 .. today]; the day-40 item sits in the prior period.
    expect(body.totalThisRange).toBe(5);
    expect(body.prevRangeTotal).toBe(1);

    expect(body.series).toHaveLength(30);
    expect(body.series.reduce((s, p) => s + p.value, 0)).toBe(5);
    // 5 items on 5 distinct London days → exactly 5 non-zero buckets.
    expect(body.series.filter((p) => p.value > 0)).toHaveLength(5);

    // bug:2 (blocking+minor), then feature/praise/question tied at 1 (label-asc tiebreak)
    expect(body.kindMix).toEqual([
      { label: "bug", value: 2 },
      { label: "feature", value: 1 },
      { label: "praise", value: 1 },
      { label: "question", value: 1 },
    ]);

    // severity in-range: 1 Blocking, 1 Minor, 3 Unspecified (feature/praise/question)
    expect(body.severityMix).toEqual([
      { label: "Unspecified", value: 3 },
      { label: "Blocking", value: 1 },
      { label: "Minor", value: 1 },
    ]);
  });

  it("computes the live all-time snapshot (status counts, resolution, board, recent, leaderboard)", async () => {
    const body = await getFeedback(projectId);

    // all 6 items (5 in-range + 1 prior-period), all-time
    expect(body.statusCounts).toEqual({ new: 2, seen: 1, planned: 1, done: 2 });
    expect(body.resolution).toEqual({ done: 2, total: 6, rate: 0.3333 });

    const boardByStatus = Object.fromEntries(
      body.board.map((col) => [col.status, col.items.map((it) => it.id)]),
    );
    // newest-first within each column
    expect(boardByStatus.new).toEqual([itemBugBlocking, itemQuestion]);
    expect(boardByStatus.seen).toEqual([itemBugMinor]);
    expect(boardByStatus.planned).toEqual([itemFeature]);
    expect(boardByStatus.done).toEqual([itemPraise, itemPrevPeriod]);

    // recent 20, any status, newest-first across ALL 6 rows (all-time — the
    // day-40 item is NOT excluded here, unlike the range-scoped numbers above)
    expect(body.recentItems.map((it) => it.id)).toEqual([
      itemPraise,
      itemBugMinor,
      itemBugBlocking,
      itemFeature,
      itemQuestion,
      itemPrevPeriod,
    ]);

    // Anonymous bucket (3×: feature/question/prevPeriod) > Ada Lovelace (2×,
    // blocking-bug + praise) > bob@x.com (1×).
    expect(body.submitterLeaderboard).toEqual([
      { label: "Anonymous", value: 3 },
      { label: "Ada Lovelace", value: 2 },
      { label: "bob@x.com", value: 1 },
    ]);
  });

  it("never throws on an empty project: zeros, empty arrays, null resolution rate", async () => {
    const body = await getFeedback(emptyProjectId);
    expect(body.totalThisRange).toBe(0);
    expect(body.prevRangeTotal).toBe(0);
    expect(body.series.every((p) => p.value === 0)).toBe(true);
    expect(body.kindMix).toEqual([]);
    expect(body.severityMix).toEqual([]);
    expect(body.statusCounts).toEqual({ new: 0, seen: 0, planned: 0, done: 0 });
    expect(body.resolution).toEqual({ done: 0, total: 0, rate: null });
    expect(body.board.every((col) => col.items.length === 0)).toBe(true);
    expect(body.recentItems).toEqual([]);
    expect(body.submitterLeaderboard).toEqual([]);
  });

  it("404s a project id from another org", async () => {
    const res = await feedbackGET(new Request("http://t/api?range=30d"), {
      params: Promise.resolve({ projectId: randomUUID() }),
    });
    expect(res.status).toBe(404);
  });
});
