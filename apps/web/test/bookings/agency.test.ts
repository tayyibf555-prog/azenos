import { randomUUID } from "node:crypto";
import { closeDb } from "@azen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAgencyBookings } from "../../lib/server/bookings";
import {
  cleanup,
  createClientRow,
  createOrg,
  createProjectRow,
  daysAgo,
  insertBooking,
} from "./helpers";

/**
 * Agency booking rate math + discovery→client conversion funnel.
 * All bookings placed inside an explicit [from,to] window so counts are exact.
 */
const ORG = randomUUID();

// Window that comfortably contains every fixture booking (placed 5..80d ago)
// and excludes nothing we insert.
const FROM = new Date(Date.now() - 100 * 86_400_000);
const TO = new Date(Date.now() + 86_400_000);

beforeAll(async () => {
  await createOrg(ORG);
  const A = await createClientRow(ORG, {
    name: "Active A",
    status: "active",
    emails: ["match@x.com"],
  });
  const B = await createClientRow(ORG, { name: "Active B", status: "active" });
  const C = await createClientRow(ORG, { name: "Lead C", status: "lead" });
  const pB = await createProjectRow(ORG, B, { name: "B project" });

  // ── Discovery (6): 3 completed, 1 no_show, 1 cancelled, 1 scheduled ──────
  // disc1 → client A (active) via clientId, completed
  await insertBooking(ORG, { kind: "discovery", status: "completed", clientId: A, startsAt: daysAgo(60) });
  // disc2 → client B (active) via clientId, completed
  await insertBooking(ORG, { kind: "discovery", status: "completed", clientId: B, startsAt: daysAgo(58) });
  // disc6 → completed, no client link (not linked)
  await insertBooking(ORG, { kind: "discovery", status: "completed", startsAt: daysAgo(56) });
  // disc3 → client C (lead) via clientId, no_show (linked, NOT converted)
  await insertBooking(ORG, { kind: "discovery", status: "no_show", clientId: C, startsAt: daysAgo(54) });
  // disc4 → email match to A (active), cancelled (linked via email, NOT
  // converted — a cancelled call never counts as a conversion)
  await insertBooking(ORG, { kind: "discovery", status: "cancelled", inviteeEmail: "MATCH@x.com", startsAt: daysAgo(52) });
  // disc5 → email with no client, scheduled (not linked)
  await insertBooking(ORG, { kind: "discovery", status: "scheduled", inviteeEmail: "nobody@x.com", startsAt: daysAgo(50) });

  // ── Kickoff (2) + Review (1): all completed ─────────────────────────────
  await insertBooking(ORG, { kind: "kickoff", status: "completed", startsAt: daysAgo(40) });
  await insertBooking(ORG, { kind: "kickoff", status: "completed", startsAt: daysAgo(38) });
  await insertBooking(ORG, { kind: "review", status: "completed", startsAt: daysAgo(20) });

  // ── An upcoming scheduled agency call (future) → counted in `upcoming` ──
  await insertBooking(ORG, { kind: "discovery", status: "scheduled", startsAt: new Date(Date.now() + 3 * 86_400_000) });

  // ── A client-end booking in-window → MUST be excluded from agency stats ──
  await insertBooking(ORG, {
    kind: "client_end_customer",
    status: "completed",
    projectId: pB,
    clientId: B,
    startsAt: daysAgo(30),
  });
}, 30_000);

afterAll(async () => {
  await cleanup(ORG);
  await closeDb();
});

describe("getAgencyBookings — rate math", () => {
  it("computes show/no-show/cancel rates over resolved bookings, excluding client-end", async () => {
    const r = await getAgencyBookings(ORG, { from: FROM, to: TO });

    // 6 discovery + 2 kickoff + 1 review = 9 past agency bookings in window.
    // The client_end_customer booking is excluded by kind; the future
    // scheduled discovery call is > TO? no — TO is now+1d and it's now+3d, so
    // it's OUTSIDE the window too. Window total = 9.
    expect(r.window.total).toBe(9);
    expect(r.window.completed).toBe(6); // 3 disc + 2 kickoff + 1 review
    expect(r.window.noShow).toBe(1);
    expect(r.window.cancelled).toBe(1);
    expect(r.window.scheduled).toBe(1);

    // resolved = completed + no_show + cancelled = 8
    expect(r.rates.resolved).toBe(8);
    expect(r.rates.showRate).toBeCloseTo(6 / 8, 10); // 0.75
    expect(r.rates.noShowRate).toBeCloseTo(1 / 8, 10); // 0.125
    expect(r.rates.cancelRate).toBeCloseTo(1 / 8, 10); // 0.125

    // Client-end kind never appears in the agency breakdown.
    expect(r.byKind.some((k) => k.kind === "client_end_customer")).toBe(false);
  });

  it("lists only future scheduled calls in `upcoming`", async () => {
    const r = await getAgencyBookings(ORG, { from: FROM, to: TO });
    // exactly the one future scheduled discovery call
    expect(r.upcoming).toHaveLength(1);
    expect(r.upcoming[0]!.status).toBe("scheduled");
    expect(new Date(r.upcoming[0]!.startsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("computes the discovery→client conversion funnel", async () => {
    const r = await getAgencyBookings(ORG, { from: FROM, to: TO });
    const c = r.conversion;
    // 6 discovery calls booked in-window (the future one is out of window)
    expect(c.discoveryBooked).toBe(6);
    expect(c.discoveryCompleted).toBe(3);
    // linked: disc1(A), disc2(B), disc3(C), disc4(email→A) = 4
    expect(c.linkedToClient).toBe(4);
    // converted = completed discovery whose linked client is active:
    // disc1(A) + disc2(B) = 2. disc4 is email→A(active) but CANCELLED, so it is
    // linked yet not converted; disc3 is no_show to a lead.
    expect(c.convertedToActive).toBe(2);
    expect(c.rate).toBeCloseTo(2 / 6, 10); // 0.333…
  });
});
