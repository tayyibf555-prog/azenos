import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@azen/db";
import { discoverMetrics } from "../../lib/server/metric-discovery";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  insertEvent,
} from "./helpers";

/**
 * discoverMetrics() against hand-built events in a throwaway org (contract:
 * "payment events → revenue metrics available; none → absent").
 */

const ORG_WITH_PAYMENTS = crypto.randomUUID();
const ORG_WITHOUT_DATA = crypto.randomUUID();

let paymentsProjectId: string;
let emptyProjectId: string;

beforeAll(async () => {
  await createOrg(ORG_WITH_PAYMENTS);
  const c1 = await createClient(ORG_WITH_PAYMENTS);
  paymentsProjectId = await createProject(ORG_WITH_PAYMENTS, c1, { type: "website" });
  for (let i = 0; i < 5; i++) {
    await insertEvent(ORG_WITH_PAYMENTS, paymentsProjectId, {
      type: "payment.captured",
      valuePence: 1000 + i,
      data: { amount_pence: 1000 + i },
    });
  }
  // a type with no value_pence at all — must NOT unlock the value-gated group
  await insertEvent(ORG_WITH_PAYMENTS, paymentsProjectId, { type: "system.error" });

  await createOrg(ORG_WITHOUT_DATA);
  const c2 = await createClient(ORG_WITHOUT_DATA);
  emptyProjectId = await createProject(ORG_WITHOUT_DATA, c2, { type: "voice_agent" });
});

afterAll(async () => {
  await cleanupOrg(ORG_WITH_PAYMENTS);
  await cleanupOrg(ORG_WITHOUT_DATA);
  await closeDb();
});

describe("discoverMetrics", () => {
  it("payment.captured events with value_pence → revenue/AOV templates available", async () => {
    const result = await discoverMetrics(ORG_WITH_PAYMENTS, paymentsProjectId);
    const keys = result.available.map((m) => m.key);
    expect(keys).toContain("revenue_attributed");
    expect(keys).toContain("avg_transaction_pence");
    const revenue = result.available.find((m) => m.key === "revenue_attributed")!;
    expect(revenue.why).toBe("payment.captured seen 5× with value_pence set");
  });

  it("no events at all → nothing available, everything required is missing", async () => {
    const result = await discoverMetrics(ORG_WITHOUT_DATA, emptyProjectId);
    expect(result.available).toEqual([]);
    // voice_agent's required preset (llm.conversation, call.completed, …)
    // has zero data → every required type shows up in `missing`.
    const missingRequired = result.missing.filter((m) => m.required);
    expect(missingRequired.length).toBeGreaterThan(0);
    expect(missingRequired.every((m) => !m.present)).toBe(true);
  });

  it("core resolves per the project's own type (voice_agent preset)", async () => {
    const result = await discoverMetrics(ORG_WITHOUT_DATA, emptyProjectId);
    const coreKeys = result.core.map((m) => m.key);
    // voice_agent's preset requires llm.conversation + booking.created →
    // their catalog templates are core reference metrics regardless of data.
    expect(coreKeys).toContain("conversations");
    expect(coreKeys).toContain("bookings_created");
  });

  it("core resolves differently for a website-type project", async () => {
    const result = await discoverMetrics(ORG_WITH_PAYMENTS, paymentsProjectId);
    const coreKeys = result.core.map((m) => m.key);
    // website's preset requires form.submitted + lead.created — no
    // conversation-specific core metrics should be pulled in.
    expect(coreKeys).not.toContain("conversation_avg_turns");
  });

  it("enabled always includes the 3 always-on derived ratios", async () => {
    const result = await discoverMetrics(ORG_WITH_PAYMENTS, paymentsProjectId);
    const enabledKeys = result.enabled.map((d) => d.key);
    for (const dk of ["agent_success_rate", "escalation_rate", "no_show_rate"]) {
      expect(enabledKeys).toContain(dk);
    }
  });
});
