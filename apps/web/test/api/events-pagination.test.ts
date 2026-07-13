import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "@azen/db";
import {
  cleanupOrg,
  createOrg,
  createTestClient,
  createTestProject,
  insertTestEvent,
} from "./helpers";

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET } from "../../app/api/projects/[projectId]/events/route";

interface EventRow {
  id: string;
  type: string;
  occurredAt: string;
}
interface PageBody {
  events: EventRow[];
  nextCursor: string | null;
}

let projectId: string;
const base = Date.now() - 3_600_000;
const inserted: { id: string; occurredAt: Date }[] = [];

function fetchEvents(query: string, id = projectId): Promise<Response> {
  return GET(
    new Request(`http://test.local/api/projects/${id}/events?${query}`),
    { params: Promise.resolve({ projectId: id }) },
  );
}

async function fetchPage(query: string): Promise<PageBody> {
  const res = await fetchEvents(query);
  expect(res.status).toBe(200);
  return (await res.json()) as PageBody;
}

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createTestClient(TEST_ORG_ID);
  projectId = await createTestProject(TEST_ORG_ID, clientId);
  // minute offsets with a tie at +4 so the page boundary crosses equal
  // occurred_at values and exercises the id tiebreak
  const specs: {
    minutes: number;
    type?: string;
    subjectName?: string;
    data?: Record<string, unknown>;
  }[] = [
    { minutes: 6, type: "booking.created", subjectName: "Walter Ipsum" },
    { minutes: 5, type: "booking.created" },
    { minutes: 4 },
    { minutes: 4 },
    { minutes: 3, data: { note: "needle-xyz" } },
    { minutes: 2 },
    { minutes: 1 },
  ];
  for (const spec of specs) {
    const occurredAt = new Date(base + spec.minutes * 60_000);
    const id = await insertTestEvent(TEST_ORG_ID, projectId, {
      occurredAt,
      type: spec.type,
      subjectName: spec.subjectName,
      data: spec.data,
    });
    inserted.push({ id, occurredAt });
  }
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

describe("GET /api/projects/[projectId]/events", () => {
  it("walks 3 keyset pages over 7 events with no overlap or gap", async () => {
    const expectedOrder = [...inserted]
      .sort(
        (a, b) =>
          b.occurredAt.getTime() - a.occurredAt.getTime() ||
          (a.id < b.id ? 1 : -1),
      )
      .map((e) => e.id);

    const p1 = await fetchPage("limit=3");
    expect(p1.events).toHaveLength(3);
    expect(p1.nextCursor).toBeTypeOf("string");

    const p2 = await fetchPage(
      `limit=3&cursor=${encodeURIComponent(p1.nextCursor ?? "")}`,
    );
    expect(p2.events).toHaveLength(3);
    expect(p2.nextCursor).toBeTypeOf("string");

    const p3 = await fetchPage(
      `limit=3&cursor=${encodeURIComponent(p2.nextCursor ?? "")}`,
    );
    expect(p3.events).toHaveLength(1);
    expect(p3.nextCursor).toBeNull();

    const walked = [...p1.events, ...p2.events, ...p3.events].map((e) => e.id);
    expect(new Set(walked).size).toBe(7);
    expect(walked).toEqual(expectedOrder);
  });

  it("returns full event rows (raw included) ordered occurred_at desc, id desc", async () => {
    const page = await fetchPage("limit=200");
    expect(page.events).toHaveLength(7);
    expect(page.nextCursor).toBeNull();
    const first = page.events[0] as unknown as Record<string, unknown>;
    expect(first).toHaveProperty("raw");
    expect(first).toHaveProperty("idempotencyKey");
    for (let i = 1; i < page.events.length; i++) {
      const a = page.events[i - 1];
      const b = page.events[i];
      if (!a || !b) throw new Error("row missing");
      const cmp = a.occurredAt.localeCompare(b.occurredAt);
      expect(cmp > 0 || (cmp === 0 && a.id > b.id)).toBe(true);
    }
  });

  it("filters by exact type, free-text q, and from/to window", async () => {
    const byType = await fetchPage("type=booking.created");
    expect(byType.events).toHaveLength(2);

    const bySubject = await fetchPage("q=walter");
    expect(bySubject.events).toHaveLength(1);
    expect(bySubject.events[0]?.type).toBe("booking.created");

    const byData = await fetchPage("q=needle-xyz");
    expect(byData.events).toHaveLength(1);

    const from = new Date(base + 4 * 60_000).toISOString();
    const to = new Date(base + 4.5 * 60_000).toISOString();
    expect((await fetchPage(`from=${from}`)).events).toHaveLength(4);
    expect((await fetchPage(`from=${from}&to=${to}`)).events).toHaveLength(2);
  });

  it("400s a malformed cursor and non-positive limit", async () => {
    const bad = await fetchEvents("cursor=!!!not-a-cursor!!!");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("cursor");

    const badLimit = await fetchEvents("limit=0");
    expect(badLimit.status).toBe(400);
  });

  it("404s a projectId that is not in this org", async () => {
    const res = await fetchEvents("limit=3", crypto.randomUUID());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "project_not_found",
    );
  });
});
