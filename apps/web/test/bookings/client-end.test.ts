import { randomUUID } from "node:crypto";
import { closeDb, db, londonMonthStartUTC } from "@azen/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  currentLondonMonth,
  getClientEndBookings,
} from "../../lib/server/bookings";
import {
  cleanup,
  createClientRow,
  createOrg,
  createProjectRow,
  insertBooking,
} from "./helpers";

const ORG = randomUUID();
let pA = "";
let pB = "";

/** Noon UTC on the 1st of the London month `monthsAgo` back — always in-month. */
function noonOnMonthStart(monthsAgo: number): Date {
  const d = londonMonthStartUTC(monthsAgo);
  d.setUTCHours(12);
  return d;
}

beforeAll(async () => {
  await createOrg(ORG);
  const A = await createClientRow(ORG, { name: "Client A" });
  const B = await createClientRow(ORG, { name: "Client B" });
  pA = await createProjectRow(ORG, A, { name: "A proj" });
  pB = await createProjectRow(ORG, B, { name: "B proj" });

  const thisMonth = noonOnMonthStart(0);
  // pA: 2 completed, 1 no_show, 1 scheduled (4 total)
  await insertBooking(ORG, { kind: "client_end_customer", status: "completed", projectId: pA, clientId: A, startsAt: thisMonth });
  await insertBooking(ORG, { kind: "client_end_customer", status: "completed", projectId: pA, clientId: A, startsAt: thisMonth });
  await insertBooking(ORG, { kind: "client_end_customer", status: "no_show", projectId: pA, clientId: A, startsAt: thisMonth });
  await insertBooking(ORG, { kind: "client_end_customer", status: "scheduled", projectId: pA, clientId: A, startsAt: thisMonth });
  // pB: 1 completed, 2 scheduled (3 total)
  await insertBooking(ORG, { kind: "client_end_customer", status: "completed", projectId: pB, clientId: B, startsAt: thisMonth });
  await insertBooking(ORG, { kind: "client_end_customer", status: "scheduled", projectId: pB, clientId: B, startsAt: thisMonth });
  await insertBooking(ORG, { kind: "client_end_customer", status: "scheduled", projectId: pB, clientId: B, startsAt: thisMonth });

  // Previous month client-end (MUST be excluded by the month window)
  await insertBooking(ORG, { kind: "client_end_customer", status: "completed", projectId: pA, clientId: A, startsAt: noonOnMonthStart(1) });
  // Current-month AGENCY discovery (MUST be excluded by kind)
  await insertBooking(ORG, { kind: "discovery", status: "completed", startsAt: thisMonth });
}, 30_000);

afterAll(async () => {
  await cleanup(ORG);
  await closeDb();
});

describe("getClientEndBookings — cross-project rollup", () => {
  it("counts only current-month client_end_customer bookings, per project", async () => {
    const r = await getClientEndBookings(ORG, currentLondonMonth());

    expect(r.total).toBe(7); // 4 (pA) + 3 (pB); prev-month + agency excluded
    expect(r.completed).toBe(3); // 2 (pA) + 1 (pB)
    expect(r.noShow).toBe(1);
    expect(r.scheduled).toBe(3);
    expect(r.cancelled).toBe(0);

    const byId = new Map(r.byProject.map((p) => [p.projectId, p]));
    expect(byId.get(pA)!.count).toBe(4);
    expect(byId.get(pA)!.completed).toBe(2);
    expect(byId.get(pA)!.noShow).toBe(1);
    expect(byId.get(pB)!.count).toBe(3);
    expect(byId.get(pB)!.completed).toBe(1);
    expect(byId.get(pB)!.scheduled).toBe(2);
  });

  it("matches a raw SQL count over the same London-month window", async () => {
    const m = currentLondonMonth();
    const first = `${m}-01`;
    const rows = (await db.execute(sql`
      select count(*)::int as n from bookings
      where org_id = ${ORG}::uuid
        and kind = 'client_end_customer'
        and starts_at >= (${first}::date)::timestamp at time zone 'Europe/London'
        and starts_at <  (${first}::date + interval '1 month')::timestamp at time zone 'Europe/London'
    `)) as unknown as { n: number }[];
    const r = await getClientEndBookings(ORG, m);
    expect(r.total).toBe(Number(rows[0]!.n));
    expect(r.total).toBe(7);
  });
});
