import { randomUUID } from "node:crypto";
import {
  bookings,
  briefs,
  db,
  events,
  expenses,
  insights,
  payments,
  projectKeys,
  projects,
  subscriptions,
  upsellProposals,
} from "@azen/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
} from "../metrics-api/helpers";

/**
 * Project deletion (Phase 7, owner action). Two throwaway orgs, NEVER
 * DEMO_ORG_ID. The money-safety invariant is the whole point: deleting a
 * project vaporises its project-scoped record data (events, bookings,
 * insights, project briefs, keys) but the AGENCY money ledger
 * (payments/subscriptions/expenses) and won-revenue history (upsell proposals)
 * SURVIVE — re-pointed to project_id NULL, never deleted (two-ledger rule §10).
 * Cross-org and unknown ids are indistinguishable 404s that touch nothing.
 */

const orgHolder = vi.hoisted(() => ({ id: "" }));
vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => orgHolder.id };
});

// Hoisted above so the route binds to the mocked requireOrgId.
import { DELETE as deleteRoute } from "../../app/api/projects/[projectId]/route";

interface Ctx {
  orgA: string;
  orgB: string;
  clientA: string;
  projectMain: string;
  projectGuarded: string;
}
const ctx: Ctx = {
  orgA: "",
  orgB: "",
  clientA: "",
  projectMain: "",
  projectGuarded: "",
};

function makeCtx(projectId: string) {
  return { params: Promise.resolve({ projectId }) } as never;
}

async function seedEvent(orgId: string, projectId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(events).values({
    id,
    orgId,
    projectId,
    type: "lead.created",
    source: "sdk",
    idempotencyKey: `del:${randomUUID()}`,
    occurredAt: new Date(),
    data: {},
    raw: {},
  });
  return id;
}

async function seedBooking(orgId: string, projectId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(bookings).values({
    id,
    orgId,
    clientId: ctx.clientA,
    projectId,
    source: "client_system",
    kind: "client_end_customer",
    startsAt: new Date(),
    status: "scheduled",
    raw: {},
  });
  return id;
}

async function seedInsight(orgId: string, projectId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(insights).values({
    id,
    orgId,
    projectId,
    kind: "anomaly",
    title: "Delete me",
    bodyMd: "body",
    status: "new",
    confidence: "med",
    createdBy: "agent",
  });
  return id;
}

async function seedKey(orgId: string, projectId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(projectKeys).values({
    id,
    orgId,
    projectId,
    publicKey: `azn_pk_${randomUUID().replace(/-/g, "")}`,
    secretHash: "deadbeef",
    authMode: "hmac",
    kind: "ingest",
  });
  return id;
}

async function seedPayment(
  orgId: string,
  projectId: string,
  clientId: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(payments).values({
    id,
    orgId,
    clientId,
    projectId,
    source: "stripe",
    kind: "retainer",
    amountPence: 120_000,
    status: "paid",
    paidAt: new Date(),
  });
  return id;
}

async function seedSubscription(
  orgId: string,
  projectId: string,
  clientId: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(subscriptions).values({
    id,
    orgId,
    clientId,
    projectId,
    amountPenceMonthly: 100_000,
    status: "active",
    startedAt: "2026-01-01",
  });
  return id;
}

async function seedExpense(orgId: string, projectId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(expenses).values({
    id,
    orgId,
    projectId,
    category: "hosting",
    vendor: "Vercel",
    amountPence: 3_000,
    incurredAt: "2026-06-01",
  });
  return id;
}

async function seedUpsell(
  orgId: string,
  projectId: string,
  clientId: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(upsellProposals).values({
    id,
    orgId,
    clientId,
    projectId,
    title: "Phase 2",
    problemMd: "p",
    proposalMd: "q",
    status: "won",
  });
  return id;
}

async function seedBrief(
  orgId: string,
  scope: "agency" | "project",
  projectId: string | null,
): Promise<string> {
  const id = randomUUID();
  await db.insert(briefs).values({
    id,
    orgId,
    scope,
    projectId,
    period: "daily",
    periodStart: new Date(),
    headline: `${scope} brief`,
    bodyMd: "body",
    status: "generated",
  });
  return id;
}

/** Full teardown: the extra ledger/record tables first (FK-safe), then the
 * shared base cleanup (events/insights/metrics/projects/clients/org). */
async function fullCleanup(orgId: string): Promise<void> {
  await db.delete(briefs).where(eq(briefs.orgId, orgId));
  await db.delete(bookings).where(eq(bookings.orgId, orgId));
  await db.delete(payments).where(eq(payments.orgId, orgId));
  await db.delete(subscriptions).where(eq(subscriptions.orgId, orgId));
  await db.delete(expenses).where(eq(expenses.orgId, orgId));
  await db.delete(upsellProposals).where(eq(upsellProposals.orgId, orgId));
  await db.delete(projectKeys).where(eq(projectKeys.orgId, orgId));
  await cleanupOrg(orgId);
}

beforeAll(async () => {
  ctx.orgA = randomUUID();
  ctx.orgB = randomUUID();
  await createOrg(ctx.orgA);
  await createOrg(ctx.orgB);
  ctx.clientA = await createClient(ctx.orgA);
  ctx.projectMain = await createProject(ctx.orgA, ctx.clientA);
  ctx.projectGuarded = await createProject(ctx.orgA, ctx.clientA);
});

afterAll(async () => {
  await fullCleanup(ctx.orgA);
  await fullCleanup(ctx.orgB);
});

describe("DELETE /api/projects/[projectId]", () => {
  it("deletes project-scoped records, keeps the agency money ledger", async () => {
    orgHolder.id = ctx.orgA;
    const p = ctx.projectMain;

    // Project-scoped record data (dies with the project).
    await seedEvent(ctx.orgA, p);
    await seedEvent(ctx.orgA, p);
    await seedBooking(ctx.orgA, p);
    await seedInsight(ctx.orgA, p);
    await seedKey(ctx.orgA, p);
    await seedKey(ctx.orgA, p);
    const projectBrief = await seedBrief(ctx.orgA, "project", p);
    const agencyBrief = await seedBrief(ctx.orgA, "agency", null);

    // Agency ledger + won-revenue history (must survive, re-pointed to NULL).
    const paymentId = await seedPayment(ctx.orgA, p, ctx.clientA);
    const subId = await seedSubscription(ctx.orgA, p, ctx.clientA);
    const expenseId = await seedExpense(ctx.orgA, p);
    const upsellId = await seedUpsell(ctx.orgA, p, ctx.clientA);

    const res = await deleteRoute(
      new Request("http://t", { method: "DELETE" }),
      makeCtx(p),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, projectId: p });

    // Project row and all its scoped records are gone.
    expect(
      await db.select().from(projects).where(eq(projects.id, p)),
    ).toHaveLength(0);
    expect(
      await db.select().from(events).where(eq(events.projectId, p)),
    ).toHaveLength(0);
    expect(
      await db.select().from(bookings).where(eq(bookings.projectId, p)),
    ).toHaveLength(0);
    expect(
      await db.select().from(insights).where(eq(insights.projectId, p)),
    ).toHaveLength(0);
    // project_keys cascade at the DB level.
    expect(
      await db.select().from(projectKeys).where(eq(projectKeys.projectId, p)),
    ).toHaveLength(0);
    // Project brief gone; agency brief untouched.
    expect(
      await db.select().from(briefs).where(eq(briefs.id, projectBrief)),
    ).toHaveLength(0);
    expect(
      await db.select().from(briefs).where(eq(briefs.id, agencyBrief)),
    ).toHaveLength(1);

    // AGENCY LEDGER SURVIVES — rows still exist, project_id nulled.
    const [pay] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(pay).toBeDefined();
    expect(pay!.projectId).toBeNull();
    expect(pay!.clientId).toBe(ctx.clientA); // client linkage intact

    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subId));
    expect(sub).toBeDefined();
    expect(sub!.projectId).toBeNull();

    const [exp] = await db
      .select()
      .from(expenses)
      .where(eq(expenses.id, expenseId));
    expect(exp).toBeDefined();
    expect(exp!.projectId).toBeNull();

    // Won-revenue upsell history survives, project_id nulled, client kept.
    const [ups] = await db
      .select()
      .from(upsellProposals)
      .where(eq(upsellProposals.id, upsellId));
    expect(ups).toBeDefined();
    expect(ups!.projectId).toBeNull();
    expect(ups!.clientId).toBe(ctx.clientA);
  });

  it("cross-org DELETE → 404 and nothing is deleted", async () => {
    const g = ctx.projectGuarded;
    await seedEvent(ctx.orgA, g);
    const guardedPayment = await seedPayment(ctx.orgA, g, ctx.clientA);

    orgHolder.id = ctx.orgB; // caller is org B, target is org A's project
    const res = await deleteRoute(
      new Request("http://t", { method: "DELETE" }),
      makeCtx(g),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project_not_found" });

    // Untouched: project, its event, and its payment (project_id intact).
    expect(
      await db.select().from(projects).where(eq(projects.id, g)),
    ).toHaveLength(1);
    expect(
      await db.select().from(events).where(eq(events.projectId, g)),
    ).toHaveLength(1);
    const [pay] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, guardedPayment));
    expect(pay).toBeDefined();
    expect(pay!.projectId).toBe(g);
  });

  it("unknown id → 404", async () => {
    orgHolder.id = ctx.orgA;
    const res = await deleteRoute(
      new Request("http://t", { method: "DELETE" }),
      makeCtx(randomUUID()),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project_not_found" });
  });

  it("non-uuid id → 404", async () => {
    orgHolder.id = ctx.orgA;
    const res = await deleteRoute(
      new Request("http://t", { method: "DELETE" }),
      makeCtx("not-a-uuid"),
    );
    expect(res.status).toBe(404);
  });
});
