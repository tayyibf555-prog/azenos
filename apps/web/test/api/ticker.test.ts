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

import { GET } from "../../app/api/ticker/route";

interface TickerRow {
  id: string;
  type: string;
  occurredAt: string;
  receivedAt: string;
  projectId: string | null;
  projectName: string;
  projectSlug: string | null;
  subjectName: string | null;
  valuePence: number | null;
  minutesSaved: number | null;
}

let projectId: string;
let e1: string;
let e2: string;
let e3: string;
let agencyEvent: string;
const t = Date.now();

async function fetchTicker(query = ""): Promise<Response> {
  return GET(new Request(`http://test.local/api/ticker?${query}`));
}

async function tickerEvents(query = ""): Promise<TickerRow[]> {
  const res = await fetchTicker(query);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { events: TickerRow[] };
  return body.events;
}

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createTestClient(TEST_ORG_ID);
  projectId = await createTestProject(TEST_ORG_ID, clientId, {
    name: "Ticker Project",
  });
  e1 = await insertTestEvent(TEST_ORG_ID, projectId, {
    occurredAt: new Date(t - 40_000),
    receivedAt: new Date(t - 4_000),
  });
  e2 = await insertTestEvent(TEST_ORG_ID, projectId, {
    occurredAt: new Date(t - 30_000),
    receivedAt: new Date(t - 3_000),
  });
  e3 = await insertTestEvent(TEST_ORG_ID, projectId, {
    occurredAt: new Date(t - 20_000),
    receivedAt: new Date(t - 2_000),
    subjectName: "Tick Subject",
    valuePence: 12_345,
    minutesSaved: 7,
  });
  // org-level event (agency Calendly style): no project
  agencyEvent = await insertTestEvent(TEST_ORG_ID, null, {
    occurredAt: new Date(t - 10_000),
    receivedAt: new Date(t - 1_000),
  });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

describe("GET /api/ticker", () => {
  it("returns org-scoped events newest-first with joined project fields", async () => {
    const events = await tickerEvents();
    // org scoping: exactly the throwaway org's 4 events, none of the demo org's
    expect(events.map((e) => e.id)).toEqual([agencyEvent, e3, e2, e1]);

    const row = events[1];
    if (!row) throw new Error("row missing");
    expect(Object.keys(row).sort()).toEqual([
      "id",
      "minutesSaved",
      "occurredAt",
      "projectId",
      "projectName",
      "projectSlug",
      "receivedAt",
      "subjectName",
      "type",
      "valuePence",
    ]);
    expect(row).toMatchObject({
      id: e3,
      projectId,
      projectName: "Ticker Project",
      subjectName: "Tick Subject",
      valuePence: 12_345,
      minutesSaved: 7,
    });
    expect(typeof row.projectSlug).toBe("string");
  });

  it('labels org-level events "Agency"', async () => {
    const events = await tickerEvents();
    const agency = events[0];
    if (!agency) throw new Error("row missing");
    expect(agency).toMatchObject({
      id: agencyEvent,
      projectId: null,
      projectName: "Agency",
      projectSlug: null,
    });
  });

  it("afterId returns only strictly newer events", async () => {
    expect((await tickerEvents(`afterId=${e2}`)).map((e) => e.id)).toEqual([
      agencyEvent,
      e3,
    ]);
    expect(await tickerEvents(`afterId=${agencyEvent}`)).toEqual([]);
  });

  it("treats an afterId invisible to this org as no lower bound", async () => {
    const events = await tickerEvents(`afterId=${crypto.randomUUID()}`);
    expect(events).toHaveLength(4);
  });

  it("clamps limit and rejects junk", async () => {
    expect(await tickerEvents("limit=2")).toHaveLength(2);
    expect(await tickerEvents("limit=999")).toHaveLength(4);
    expect((await fetchTicker("limit=abc")).status).toBe(400);
    expect((await fetchTicker("afterId=not-a-uuid")).status).toBe(400);
  });
});
