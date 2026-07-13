import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  bookings,
  briefs,
  clients,
  db,
  events,
  expenses,
  insights,
  londonTodayUTC,
  metricDefinitions,
  metricRollups,
  organizations,
  payments,
  projects,
  subscriptions,
  upsellProposals,
} from "@azen/db";
import {
  ASK_TOOLS,
  runTool,
  toAnthropicTools,
} from "../../lib/server/ask/tools/index";

/**
 * P3B-TOOLS tests (docs/phase3b/CONTRACTS.md). Real local DB, two throwaway orgs
 * (A = the org under test, B = the "other org" used to prove isolation). Every
 * row hangs off a random org id and is removed in afterAll; DEMO_ORG_ID is never
 * touched. Numbers are hand-computed in comments.
 */

const orgA = randomUUID();
const orgB = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const projA1 = randomUUID();
const projA2 = randomUUID();
const projB1 = randomUUID();
const slugA1 = `ask-a1-${orgA.slice(0, 8)}`;
const slugA2 = `ask-a2-${orgA.slice(0, 8)}`;
const slugB1 = `ask-b1-${orgB.slice(0, 8)}`;

/** YYYY-MM-DD of the London date `daysAgo` before today. */
function londonDateStr(daysAgo: number): string {
  const d = londonTodayUTC();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
/** Noon-UTC on a London date `daysAgo` back — same London day in GMT and BST,
 * and always inside the trailing-30-day rollup window the tool defaults to. */
function noon(daysAgo: number): Date {
  return new Date(`${londonDateStr(daysAgo)}T12:00:00Z`);
}

async function insertOrg(id: string): Promise<void> {
  await db.insert(organizations).values({ id, name: `Ask Test ${id.slice(0, 8)}` });
}
async function insertClient(id: string, orgId: string, name: string): Promise<void> {
  await db.insert(clients).values({ id, orgId, name, status: "active" });
}
async function insertProject(
  id: string,
  orgId: string,
  clientId: string,
  slug: string,
  name: string,
  opts: { status?: "live" | "building"; retainer?: number } = {},
): Promise<void> {
  await db.insert(projects).values({
    id,
    orgId,
    clientId,
    slug,
    name,
    type: "ai_agent",
    stack: "custom_code",
    status: opts.status ?? "live",
    health: "green",
    retainerPenceMonthly: opts.retainer ?? 0,
  });
}
async function insertRollup(
  orgId: string,
  projectId: string,
  key: string,
  periodStart: Date,
  value: number,
): Promise<void> {
  await db.insert(metricRollups).values({
    orgId,
    projectId,
    metricKey: key,
    period: "day",
    periodStart,
    value,
    sampleCount: 1,
  });
}
async function insertEvent(
  orgId: string,
  projectId: string | null,
  type: string,
  occurredAt: Date,
  data: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(events).values({
    id,
    orgId,
    projectId,
    type,
    source: "sdk",
    idempotencyKey: `ask:${randomUUID()}`,
    occurredAt,
    data,
    raw: data,
  });
  return id;
}

beforeAll(async () => {
  await insertOrg(orgA);
  await insertOrg(orgB);
  await insertClient(clientA, orgA, "Acme Dental");
  await insertClient(clientB, orgB, "Other Org Co");
  await insertProject(projA1, orgA, clientA, slugA1, "Reception Agent", {
    retainer: 50_000,
  });
  await insertProject(projA2, orgA, clientA, slugA2, "Recall Bot", {
    retainer: 30_000,
  });
  await insertProject(projB1, orgB, clientB, slugB1, "Rival Bot");

  // ── metric rollups ────────────────────────────────────────────────────────
  // bookings_created on the SAME day for both A projects (noon → one bucket):
  //   A1 = 10, A2 = 4  → project A1 alone = 10; org-wide A = 14.
  await insertRollup(orgA, projA1, "bookings_created", noon(5), 10);
  await insertRollup(orgA, projA2, "bookings_created", noon(5), 4);
  // orgB rollup on the same day — must NEVER be summed into orgA's org-wide read.
  await insertRollup(orgB, projB1, "bookings_created", noon(5), 100);
  // derived agent_success_rate on A1: 8/10 = 80%.
  await insertRollup(orgA, projA1, "agent_runs", noon(3), 10);
  await insertRollup(orgA, projA1, "agent_runs_succeeded", noon(3), 8);
  // a global definition so query_metric_rollups meta.name is meaningful.
  await db.insert(metricDefinitions).values({
    orgId: orgA,
    projectId: null,
    key: "bookings_created",
    name: "Bookings created",
    unit: "count",
    aggregation: "count",
    eventType: "booking.created",
  });

  // ── events ────────────────────────────────────────────────────────────────
  // 60 events on A1 → search_events must cap at 50. One carries a marker text.
  for (let i = 0; i < 60; i++) {
    await insertEvent(orgA, projA1, "conversation.message", noon(2), {
      i,
      note: i === 0 ? "unicorn-marker" : "plain",
    });
  }
  // an orgB event that must never surface in orgA searches.
  await insertEvent(orgB, projB1, "conversation.message", noon(2), {
    note: "orgB-secret",
  });

  // ── money ─────────────────────────────────────────────────────────────────
  // active MRR = 50000 + 30000 = 80000; a cancelled sub is excluded.
  await db.insert(subscriptions).values([
    {
      orgId: orgA,
      clientId: clientA,
      projectId: projA1,
      amountPenceMonthly: 50_000,
      status: "active",
      startedAt: londonDateStr(30),
    },
    {
      orgId: orgA,
      clientId: clientA,
      projectId: projA2,
      amountPenceMonthly: 30_000,
      status: "active",
      startedAt: londonDateStr(30),
    },
    {
      orgId: orgA,
      clientId: clientA,
      amountPenceMonthly: 999_999,
      status: "cancelled",
      startedAt: londonDateStr(60),
    },
    // orgB active sub — must not count toward orgA MRR.
    {
      orgId: orgB,
      clientId: clientB,
      amountPenceMonthly: 777_777,
      status: "active",
      startedAt: londonDateStr(30),
    },
  ]);
  // payments: paid 20000 (in range) + pending 15000.
  await db.insert(payments).values([
    {
      orgId: orgA,
      clientId: clientA,
      projectId: projA1,
      source: "stripe",
      kind: "retainer",
      amountPence: 20_000,
      status: "paid",
      paidAt: noon(4),
    },
    {
      orgId: orgA,
      clientId: clientA,
      source: "bank_transfer",
      kind: "retainer",
      amountPence: 15_000,
      status: "pending",
    },
    {
      orgId: orgB,
      clientId: clientB,
      source: "stripe",
      kind: "retainer",
      amountPence: 500_000,
      status: "paid",
      paidAt: noon(4),
    },
  ]);
  // expenses: 3000 + 4500 = 7500 for orgA.
  await db.insert(expenses).values([
    {
      orgId: orgA,
      projectId: projA1,
      category: "api",
      vendor: "Anthropic",
      amountPence: 3_000,
      incurredAt: londonDateStr(4),
    },
    {
      orgId: orgA,
      category: "hosting",
      vendor: "Vercel",
      amountPence: 4_500,
      incurredAt: londonDateStr(4),
    },
    {
      orgId: orgB,
      category: "api",
      vendor: "Anthropic",
      amountPence: 90_000,
      incurredAt: londonDateStr(4),
    },
  ]);

  // ── bookings ──────────────────────────────────────────────────────────────
  await db.insert(bookings).values([
    {
      orgId: orgA,
      clientId: clientA,
      projectId: projA1,
      source: "client_system",
      kind: "client_end_customer",
      startsAt: noon(6),
      status: "completed",
    },
    {
      orgId: orgA,
      clientId: clientA,
      projectId: projA1,
      source: "client_system",
      kind: "client_end_customer",
      startsAt: noon(1),
      status: "no_show",
    },
    {
      orgId: orgA,
      clientId: clientA,
      source: "calendly",
      kind: "discovery",
      startsAt: noon(7),
      status: "scheduled",
    },
    // orgB booking — must not surface for orgA.
    {
      orgId: orgB,
      clientId: clientB,
      projectId: projB1,
      source: "client_system",
      kind: "client_end_customer",
      startsAt: noon(1),
      status: "completed",
    },
  ]);

  // ── agent outputs ───────────────────────────────────────────────────────────
  await db.insert(briefs).values({
    orgId: orgA,
    scope: "agency",
    period: "daily",
    periodStart: noon(1),
    headline: "Yesterday: 14 bookings across the fleet",
    bodyMd: "All systems green. unicorn-brief marker.",
    status: "generated",
  });
  await db.insert(insights).values({
    orgId: orgA,
    projectId: projA1,
    kind: "risk",
    title: "No-show rate climbing",
    bodyMd: "Consider reminder automation.",
    status: "new",
    confidence: "high",
    createdBy: "agent",
  });
  await db.insert(upsellProposals).values({
    orgId: orgA,
    clientId: clientA,
    projectId: projA1,
    title: "Add SMS reminders",
    problemMd: "No-shows cost money.",
    proposalMd: "We build SMS reminders.",
    status: "ready",
  });
  // orgB insight — isolation check.
  await db.insert(insights).values({
    orgId: orgB,
    projectId: projB1,
    kind: "risk",
    title: "orgB-secret-insight",
    bodyMd: "should never surface for orgA",
    status: "new",
    confidence: "high",
    createdBy: "agent",
  });
});

afterAll(async () => {
  for (const o of [orgA, orgB]) {
    await db.delete(payments).where(eq(payments.orgId, o));
    await db.delete(subscriptions).where(eq(subscriptions.orgId, o));
    await db.delete(expenses).where(eq(expenses.orgId, o));
    await db.delete(bookings).where(eq(bookings.orgId, o));
    await db.delete(briefs).where(eq(briefs.orgId, o));
    await db.delete(upsellProposals).where(eq(upsellProposals.orgId, o));
    await db.delete(insights).where(eq(insights.orgId, o));
    await db.delete(metricRollups).where(eq(metricRollups.orgId, o));
    await db.delete(metricDefinitions).where(eq(metricDefinitions.orgId, o));
    await db.delete(events).where(eq(events.orgId, o));
    await db.delete(projects).where(eq(projects.orgId, o));
    await db.delete(clients).where(eq(clients.orgId, o));
    await db.delete(organizations).where(eq(organizations.id, o));
  }
});

// ── registry / projection ──────────────────────────────────────────────────

describe("registry", () => {
  it("exposes exactly the contracted tools", () => {
    const names = ASK_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_business_snapshot",
        "list_bookings",
        "list_expenses",
        "list_payments",
        "money_summary",
        "query_metric_rollups",
        "run_sql",
        "search_briefs_insights",
        "search_events",
        "search_knowledge",
      ].sort(),
    );
  });

  it("projects to Anthropic tool params with object JSON schemas", () => {
    const tools = toAnthropicTools(ASK_TOOLS);
    expect(tools).toHaveLength(ASK_TOOLS.length);
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.input_schema.type).toBe("object");
    }
  });

  it("runTool rejects an unknown tool and invalid input as ToolResult errors", async () => {
    const unknown = await runTool("nope", orgA, {});
    expect(unknown.ok).toBe(false);
    // metric_key is required → invalid input surfaces as an error, not a throw.
    const bad = await runTool("query_metric_rollups", orgA, { period: "day" });
    expect(bad.ok).toBe(false);
  });
});

// ── individual tools ────────────────────────────────────────────────────────

describe("get_business_snapshot", () => {
  it("summarizes only this org", async () => {
    const r = await runTool("get_business_snapshot", orgA, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as {
      mrrPence: number;
      clients: { count: number; list: { name: string }[] };
      projects: { count: number; byStatus: Record<string, number> };
    };
    expect(d.mrrPence).toBe(80_000); // 50000 + 30000, cancelled excluded
    expect(d.clients.count).toBe(1);
    expect(d.projects.count).toBe(2);
    const names = d.clients.list.map((c) => c.name);
    expect(names).toContain("Acme Dental");
    expect(names).not.toContain("Other Org Co");
  });
});

describe("query_metric_rollups", () => {
  it("scopes to one project by slug", async () => {
    const r = await runTool("query_metric_rollups", orgA, {
      project_slug: slugA1,
      metric_key: "bookings_created",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as {
      series: { value: number }[];
      meta: { name: string; unit: string };
    };
    const sum = d.series.reduce((a, p) => a + p.value, 0);
    expect(sum).toBe(10); // A1 only
    expect(d.meta.name).toBe("Bookings created");
  });

  it("sums across the org when no slug is given, excluding other orgs", async () => {
    const r = await runTool("query_metric_rollups", orgA, {
      metric_key: "bookings_created",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { series: { value: number }[] };
    const sum = d.series.reduce((a, p) => a + p.value, 0);
    expect(sum).toBe(14); // 10 + 4, NOT + 100 from orgB
  });

  it("computes derived ratio keys", async () => {
    const r = await runTool("query_metric_rollups", orgA, {
      project_slug: slugA1,
      metric_key: "agent_success_rate",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as {
      series: { value: number | null }[];
      meta: { unit: string };
    };
    expect(d.meta.unit).toBe("percent");
    expect(d.series.some((p) => p.value === 80)).toBe(true);
  });

  it("returns an empty series (no leak) for an unknown slug", async () => {
    const r = await runTool("query_metric_rollups", orgA, {
      project_slug: "does-not-exist",
      metric_key: "bookings_created",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { series: unknown[] };
    expect(d.series).toHaveLength(0);
  });

  it("cannot read another org's project by slug", async () => {
    const r = await runTool("query_metric_rollups", orgA, {
      project_slug: slugB1, // belongs to orgB
      metric_key: "bookings_created",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { series: unknown[] };
    expect(d.series).toHaveLength(0);
  });
});

describe("search_events", () => {
  it("caps at 50 and never returns another org's events", async () => {
    const r = await runTool("search_events", orgA, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { events: { id: string; data: unknown }[] };
    expect(d.events).toHaveLength(50); // 60 inserted, capped
    for (const e of d.events) {
      expect(JSON.stringify(e.data)).not.toContain("orgB-secret");
    }
  });

  it("filters by free text", async () => {
    const r = await runTool("search_events", orgA, { text: "unicorn-marker" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { events: unknown[] };
    expect(d.events).toHaveLength(1);
  });

  it("returns empty for an unknown slug", async () => {
    const r = await runTool("search_events", orgA, { project_slug: "nope" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { events: unknown[] };
    expect(d.events).toHaveLength(0);
  });
});

describe("money_summary", () => {
  it("reports MRR, payments and expenses for this org only", async () => {
    const r = await runTool("money_summary", orgA, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as {
      mrrPence: number;
      payments: { paidPence: number; pendingPence: number; overduePence: number };
      expensesPence: number;
    };
    expect(d.mrrPence).toBe(80_000);
    expect(d.payments.paidPence).toBe(20_000);
    expect(d.payments.pendingPence).toBe(15_000);
    expect(d.payments.overduePence).toBe(15_000);
    expect(d.expensesPence).toBe(7_500); // 3000 + 4500, orgB's 90000 excluded
  });

  it("degrades to zeros for an org with no money data", async () => {
    const r = await runTool("money_summary", orgB, { from: londonDateStr(0), to: londonDateStr(0) });
    // orgB has money, but a today-only window excludes its back-dated rows →
    // paid within range is 0, proving graceful zeroing without error.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { payments: { paidPence: number } };
    expect(d.payments.paidPence).toBe(0);
  });
});

describe("list_payments / list_expenses", () => {
  it("list_payments filters by status, org-scoped", async () => {
    const r = await runTool("list_payments", orgA, { status: "paid" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { payments: { amountPence: number }[] };
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0]?.amountPence).toBe(20_000);
  });

  it("list_expenses is org-scoped", async () => {
    const r = await runTool("list_expenses", orgA, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { expenses: { amountPence: number }[] };
    expect(d.expenses).toHaveLength(2);
    const total = d.expenses.reduce((a, e) => a + e.amountPence, 0);
    expect(total).toBe(7_500);
  });
});

describe("list_bookings", () => {
  it("filters by kind and stays org-scoped", async () => {
    const r = await runTool("list_bookings", orgA, {
      kind: "client_end_customer",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { bookings: { status: string }[] };
    expect(d.bookings).toHaveLength(2); // completed + no_show, orgB excluded
  });

  it("filters by status", async () => {
    const r = await runTool("list_bookings", orgA, { status: "no_show" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { bookings: unknown[] };
    expect(d.bookings).toHaveLength(1);
  });
});

describe("search_briefs_insights", () => {
  it("searches all three tables and stays org-scoped", async () => {
    const r = await runTool("search_briefs_insights", orgA, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { results: { source: string; title: string }[] };
    const sources = new Set(d.results.map((x) => x.source));
    expect(sources.has("brief")).toBe(true);
    expect(sources.has("insight")).toBe(true);
    expect(sources.has("upsell_proposal")).toBe(true);
    for (const x of d.results) {
      expect(x.title).not.toContain("orgB-secret");
    }
  });

  it("narrows to insights when a kind is given", async () => {
    const r = await runTool("search_briefs_insights", orgA, { kind: "risk" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { results: { source: string }[] };
    expect(d.results.length).toBeGreaterThan(0);
    for (const x of d.results) expect(x.source).toBe("insight");
  });

  it("filters by free text across tables", async () => {
    const r = await runTool("search_briefs_insights", orgA, {
      text: "unicorn-brief",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { results: { source: string }[] };
    expect(d.results).toHaveLength(1);
    expect(d.results[0]?.source).toBe("brief");
  });
});

describe("search_knowledge", () => {
  it("degrades to the empty-KB note when nothing is embedded (no VOYAGE_API_KEY)", async () => {
    // P6-LEARN swapped the stub for real pgvector retrieval; with no
    // VOYAGE_API_KEY in the test env the query can't be embedded, so the tool
    // returns an empty result set with a clear note rather than the old stub.
    const r = await runTool("search_knowledge", orgA, { text: "dental" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { results: unknown[]; note: string };
    expect(d.results).toEqual([]);
    expect(d.note).toBe("no knowledge base entries yet");
  });
});

describe("run_sql", () => {
  it("relays a blocked (write) query as a ToolResult error", async () => {
    const r = await runTool("run_sql", orgA, {
      query: "delete from events",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(typeof r.error).toBe("string");
  });

  it("runs a valid SELECT and returns rows", async () => {
    const r = await runTool("run_sql", orgA, {
      query: `select count(*)::int as n from projects where org_id = '${orgA}'`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { rows: { n: number }[]; rowCount: number };
    expect(d.rows[0]?.n).toBe(2);
  });
});
