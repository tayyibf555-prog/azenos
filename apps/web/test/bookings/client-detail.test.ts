import { randomUUID } from "node:crypto";
import { clients, closeDb, db } from "@azen/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClientDetail } from "../../lib/server/bookings";
import {
  cleanup,
  createClientRow,
  createOrg,
  createProjectRow,
  insertBooking,
  insertPayment,
} from "./helpers";

const ORG = randomUUID();
let A = "";

beforeAll(async () => {
  await createOrg(ORG);
  A = await createClientRow(ORG, { name: "LTV Client", status: "active" });
  const p = await createProjectRow(ORG, A, {
    name: "LTV proj",
    retainerPenceMonthly: 40_000,
    retainerActive: true,
  });

  // Paid agency payments → counted toward LTV: 500000 + 30000 + 20000 = 550000
  await insertPayment(ORG, A, { kind: "build_fee", status: "paid", amountPence: 500_000, projectId: p });
  await insertPayment(ORG, A, { kind: "retainer", status: "paid", amountPence: 30_000, projectId: p });
  await insertPayment(ORG, A, { kind: "deposit", status: "paid", amountPence: 20_000, projectId: p });
  // NOT paid → excluded from LTV
  await insertPayment(ORG, A, { kind: "retainer", status: "pending", amountPence: 30_000, projectId: p });
  await insertPayment(ORG, A, { kind: "other", status: "failed", amountPence: 99_999, projectId: p });
  await insertPayment(ORG, A, { kind: "retainer", status: "refunded", amountPence: 12_345, projectId: p });

  // A booking so the detail bookings list is non-empty.
  await insertBooking(ORG, { kind: "kickoff", status: "completed", clientId: A, projectId: p, startsAt: new Date() });
}, 30_000);

afterAll(async () => {
  await cleanup(ORG);
  await closeDb();
});

describe("getClientDetail — LTV = Σ paid agency payments", () => {
  it("sums only paid payments and caches to clients.ltvCachePence", async () => {
    const d = await getClientDetail(ORG, A);
    expect(d).not.toBeNull();

    // 500000 + 30000 + 20000 = 550000 (pending/failed/refunded excluded)
    expect(d!.ltvPence).toBe(550_000);
    expect(d!.payments).toHaveLength(6);

    // Cache column written back with the freshly computed value.
    const [row] = await db
      .select({ ltv: clients.ltvCachePence })
      .from(clients)
      .where(and(eq(clients.id, A), eq(clients.orgId, ORG)));
    expect(row!.ltv).toBe(550_000);
  });

  it("exposes project margin = retainer − attributed cost (0 cost here)", async () => {
    const d = await getClientDetail(ORG, A);
    const proj = d!.projects[0]!;
    // No metric_rollups / agent_runs seeded → attributed cost 0.
    expect(proj.costThisMonthPence).toBe(0);
    // retainerActive → margin = 40000 − 0 = 40000
    expect(proj.marginPence).toBe(40_000);
  });

  it("returns null for a client id not in this org", async () => {
    const d = await getClientDetail(ORG, randomUUID());
    expect(d).toBeNull();
  });
});
