import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BenchmarkBlock } from "../../components/BenchmarkBlock";
import {
  type ClientBenchmark,
  computeIndustryBenchmark,
  loadClientBenchmarkUncached,
  percentile,
  percentilesFromValues,
} from "../../lib/server/benchmarks";
import {
  cleanupOrg,
  createClient,
  createIndustry,
  createLiveProject,
  createOrg,
  insertDayRollup,
} from "./helpers";

/**
 * §P8-BENCH acceptance. Percentile math is hand-computed; the anonymity floor
 * (fewer than three distinct clients ⇒ null) is verified end-to-end; the report
 * slot renders and hides gracefully. Every DB test runs under a fresh throwaway
 * org — DEMO_ORG_ID is never touched.
 */

// A complete past London month (BST → boundaries round-trip to 00:00Z here).
const MONTH_START = new Date("2026-05-01T00:00:00Z");
const MONTH_END = new Date("2026-06-01T00:00:00Z");
const IN_MONTH = new Date("2026-05-10T12:00:00Z");
const IN_MONTH_2 = new Date("2026-05-11T12:00:00Z");

describe("percentile math", () => {
  it("linear-interpolates like numpy / percentile_cont", () => {
    const s = [100, 300, 500];
    expect(percentile(s, 0.25)).toBe(200);
    expect(percentile(s, 0.5)).toBe(300);
    expect(percentile(s, 0.75)).toBe(400);
  });

  it("handles single and empty samples", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([], 0.5)).toBe(0);
  });

  it("percentilesFromValues sorts before interpolating", () => {
    expect(percentilesFromValues([500, 100, 300])).toEqual({
      p25: 200,
      p50: 300,
      p75: 400,
    });
  });
});

describe("computeIndustryBenchmark", () => {
  const orgs: string[] = [];
  afterEach(async () => {
    while (orgs.length) await cleanupOrg(orgs.pop()!);
  });

  it("computes p25/p50/p75 across the industry's clients (≥3)", async () => {
    const orgId = randomUUID();
    orgs.push(orgId);
    await createOrg(orgId);
    const industryId = await createIndustry(orgId);

    // revenue_attributed totals per client: A=100, B=300 (two buckets), C=500.
    const a = await createClient(orgId, { industryId, name: "Alpha" });
    const b = await createClient(orgId, { industryId, name: "Beta" });
    const c = await createClient(orgId, { industryId, name: "Gamma" });
    const pa = await createLiveProject(orgId, a);
    const pb = await createLiveProject(orgId, b);
    const pc = await createLiveProject(orgId, c);
    await insertDayRollup(orgId, pa, "revenue_attributed", IN_MONTH, 100);
    await insertDayRollup(orgId, pb, "revenue_attributed", IN_MONTH, 120);
    await insertDayRollup(orgId, pb, "revenue_attributed", IN_MONTH_2, 180);
    await insertDayRollup(orgId, pc, "revenue_attributed", IN_MONTH, 500);

    const result = await computeIndustryBenchmark({
      orgId,
      industryId,
      start: MONTH_START,
      end: MONTH_END,
    });
    expect(result).not.toBeNull();
    expect(result!.sampleClients).toBe(3);
    expect(result!.metrics["revenue_attributed"]).toEqual({
      p25: 200,
      p50: 300,
      p75: 400,
    });
    // Beta's two buckets summed to 300 (per-client monthly aggregate).
    expect(result!.perClientRaw.get(b)!.get("revenue_attributed")).toBe(300);
  });

  it("returns null below the anonymity floor (2 distinct clients)", async () => {
    const orgId = randomUUID();
    orgs.push(orgId);
    await createOrg(orgId);
    const industryId = await createIndustry(orgId);
    const a = await createClient(orgId, { industryId });
    const b = await createClient(orgId, { industryId });
    const pa = await createLiveProject(orgId, a);
    const pb = await createLiveProject(orgId, b);
    await insertDayRollup(orgId, pa, "revenue_attributed", IN_MONTH, 100);
    await insertDayRollup(orgId, pb, "revenue_attributed", IN_MONTH, 300);

    const result = await computeIndustryBenchmark({
      orgId,
      industryId,
      start: MONTH_START,
      end: MONTH_END,
    });
    expect(result).toBeNull();
  });

  it("excludes non-live projects from the sample", async () => {
    const orgId = randomUUID();
    orgs.push(orgId);
    await createOrg(orgId);
    const industryId = await createIndustry(orgId);
    const a = await createClient(orgId, { industryId });
    const b = await createClient(orgId, { industryId });
    const c = await createClient(orgId, { industryId });
    const pa = await createLiveProject(orgId, a);
    const pb = await createLiveProject(orgId, b);
    // c's only project is paused → c is not a live-project client → floor not met.
    const pc = await createLiveProject(orgId, c, { status: "paused" });
    await insertDayRollup(orgId, pa, "revenue_attributed", IN_MONTH, 100);
    await insertDayRollup(orgId, pb, "revenue_attributed", IN_MONTH, 300);
    await insertDayRollup(orgId, pc, "revenue_attributed", IN_MONTH, 999);

    const result = await computeIndustryBenchmark({
      orgId,
      industryId,
      start: MONTH_START,
      end: MONTH_END,
    });
    expect(result).toBeNull();
  });
});

describe("loadClientBenchmark", () => {
  const orgs: string[] = [];
  afterEach(async () => {
    while (orgs.length) await cleanupOrg(orgs.pop()!);
  });

  async function seedIndustry(orgId: string): Promise<{
    industryId: string;
    a: string;
    c: string;
  }> {
    const industryId = await createIndustry(orgId, "Dental");
    const a = await createClient(orgId, { industryId, name: "Alpha" });
    const b = await createClient(orgId, { industryId, name: "Beta" });
    const c = await createClient(orgId, { industryId, name: "Gamma" });
    for (const [clientId, rev, mins, convos] of [
      [a, 100, 600, 10],
      [b, 300, 1200, 30],
      [c, 500, 1800, 50],
    ] as const) {
      const p = await createLiveProject(orgId, clientId);
      await insertDayRollup(orgId, p, "revenue_attributed", IN_MONTH, rev);
      await insertDayRollup(orgId, p, "minutes_saved", IN_MONTH, mins);
      await insertDayRollup(orgId, p, "conversations", IN_MONTH, convos);
    }
    return { industryId, a, c };
  }

  it("shapes the subject client's white-label bars vs the median", async () => {
    const orgId = randomUUID();
    orgs.push(orgId);
    await createOrg(orgId);
    const { a, c } = await seedIndustry(orgId);

    const below = await loadClientBenchmarkUncached(orgId, a, {
      monthStartUTC: MONTH_START,
    });
    expect(below).not.toBeNull();
    expect(below!.industryName).toBe("Dental");
    expect(below!.monthLabel).toBe("May 2026");
    expect(below!.sampleClients).toBe(3);

    const rev = below!.bars.find((x) => x.key === "revenue_attributed")!;
    expect(rev.clientValue).toBe(100); // pence display
    expect(rev.p50).toBe(300);
    expect(rev.standing).toBe("behind");

    const hours = below!.bars.find((x) => x.key === "minutes_saved")!;
    expect(hours.clientValue).toBe(10); // 600 min → 10h
    expect(hours.p50).toBe(20); // 1200 min → 20h

    // The top client is ahead of the median.
    const above = await loadClientBenchmarkUncached(orgId, c, {
      monthStartUTC: MONTH_START,
    });
    expect(above!.bars.find((x) => x.key === "revenue_attributed")!.standing).toBe(
      "ahead",
    );

    // White-label: no org id, no client id, no other client's name/value leak.
    const serialised = JSON.stringify(below);
    expect(serialised).not.toContain(orgId);
    expect(serialised).not.toContain(a);
    expect(serialised).not.toContain(c);
    expect(serialised).not.toContain("Gamma");
  });

  it("hides zero-signal metrics (a key with no rollups anywhere)", async () => {
    const orgId = randomUUID();
    orgs.push(orgId);
    await createOrg(orgId);
    const industryId = await createIndustry(orgId);
    let subject = "";
    for (let i = 0; i < 3; i++) {
      const clientId = await createClient(orgId, { industryId });
      if (i === 0) subject = clientId;
      const p = await createLiveProject(orgId, clientId);
      // Only revenue — conversations / minutes_saved stay entirely absent.
      await insertDayRollup(orgId, p, "revenue_attributed", IN_MONTH, (i + 1) * 100);
    }
    const result = await loadClientBenchmarkUncached(orgId, subject, {
      monthStartUTC: MONTH_START,
    });
    expect(result!.bars.map((b) => b.key)).toEqual(["revenue_attributed"]);
  });

  it("returns null for a client with no industry", async () => {
    const orgId = randomUUID();
    orgs.push(orgId);
    await createOrg(orgId);
    const clientId = await createClient(orgId, { industryId: null });
    await createLiveProject(orgId, clientId);
    const result = await loadClientBenchmarkUncached(orgId, clientId, {
      monthStartUTC: MONTH_START,
    });
    expect(result).toBeNull();
  });
});

describe("BenchmarkBlock rendering", () => {
  const sample: ClientBenchmark = {
    industryName: "Dental",
    monthLabel: "May 2026",
    sampleClients: 4,
    bars: [
      {
        key: "revenue_attributed",
        label: "Value delivered",
        unit: "pence",
        goodDirection: "up",
        clientValue: 125000,
        p25: 80000,
        p50: 100000,
        p75: 140000,
        standing: "ahead",
      },
    ],
  };

  it("renders the block with the industry, month and median", () => {
    const html = renderToStaticMarkup(
      createElement(BenchmarkBlock, { data: sample, variant: "report" }),
    );
    expect(html).toContain("How this compares");
    expect(html).toContain("Dental");
    expect(html).toContain("May 2026");
    expect(html).toContain("Ahead of median");
  });

  it("degrades to hidden when data is null", () => {
    const html = renderToStaticMarkup(
      createElement(BenchmarkBlock, { data: null }),
    );
    expect(html).toBe("");
  });

  it("degrades to hidden when there are no bars", () => {
    const html = renderToStaticMarkup(
      createElement(BenchmarkBlock, {
        data: { ...sample, bars: [] },
      }),
    );
    expect(html).toBe("");
  });
});
