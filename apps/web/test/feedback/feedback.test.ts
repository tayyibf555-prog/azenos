import { randomUUID } from "node:crypto";
import { closeDb, db, events, feedbackItems, projectKeys } from "@azen/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as ingestPOST } from "../../app/api/ingest/[publicKey]/route";
import { PER_IP_LIMIT } from "../../lib/server/feedback/rate-limit";
import {
  cleanupFeedbackHarness,
  createFeedbackHarness,
  readJson,
  sendFeedback,
  type FeedbackHarness,
} from "./helpers";

const eventsFor = (h: FeedbackHarness) =>
  db.select().from(events).where(eq(events.orgId, h.orgId));
const itemsFor = (h: FeedbackHarness) =>
  db.select().from(feedbackItems).where(eq(feedbackItems.orgId, h.orgId));

describe("POST /api/feedback/[publicKey]", () => {
  let h: FeedbackHarness;

  beforeAll(async () => {
    h = await createFeedbackHarness();
  });

  afterEach(async () => {
    // keep each case independent — clear rows the previous case wrote
    await db.delete(feedbackItems).where(eq(feedbackItems.orgId, h.orgId));
    await db.delete(events).where(eq(events.orgId, h.orgId));
  });

  afterAll(async () => {
    await cleanupFeedbackHarness(h);
    await closeDb();
  });

  it("writes an event + a mirror row on a valid submission", async () => {
    const res = await sendFeedback(h.feedbackPublicKey, {
      kind: "bug",
      message: "The booking button does nothing on mobile Safari.",
      severity: 3,
      submitter: { name: "Front Desk", email: "desk@clinic.example" },
      page_url: "https://clinic.example/book",
    });
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json).toEqual({ ok: true });
    // CORS for cross-origin widget embeds
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // response body must never leak org/project ids
    const asText = JSON.stringify(json);
    expect(asText).not.toContain(h.orgId);
    expect(asText).not.toContain(h.projectId);

    const evs = await eventsFor(h);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.type).toBe("feedback.submitted");
    expect(evs[0]!.source).toBe("feedback");
    expect(evs[0]!.projectId).toBe(h.projectId);
    expect((evs[0]!.data as { kind: string }).kind).toBe("bug");

    const items = await itemsFor(h);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("bug");
    expect(items[0]!.severity).toBe(3);
    expect(items[0]!.status).toBe("new");
    expect(items[0]!.submitterEmail).toBe("desk@clinic.example");
    expect(items[0]!.eventId).toBe(evs[0]!.id);
  });

  it("honeypot: a non-empty `website` returns 200 but writes NOTHING", async () => {
    const res = await sendFeedback(h.feedbackPublicKey, {
      kind: "bug",
      message: "spammy",
      website: "https://buy-cheap-pills.example",
    });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true });
    expect(await eventsFor(h)).toHaveLength(0);
    expect(await itemsFor(h)).toHaveLength(0);
  });

  it("rejects a revoked feedback key with 401", async () => {
    // revoke this project's feedback key, then restore it after the assertion
    await db
      .update(projectKeys)
      .set({ revokedAt: new Date() })
      .where(eq(projectKeys.id, h.feedbackKeyId));
    const res = await sendFeedback(h.feedbackPublicKey, {
      kind: "bug",
      message: "should be rejected",
    });
    expect(res.status).toBe(401);
    expect(await eventsFor(h)).toHaveLength(0);
    await db
      .update(projectKeys)
      .set({ revokedAt: null })
      .where(eq(projectKeys.id, h.feedbackKeyId));
  });

  it("rejects an unknown public key with 401", async () => {
    const res = await sendFeedback(`azn_fb_missing_${randomUUID()}`, {
      kind: "bug",
      message: "no such key",
    });
    expect(res.status).toBe(401);
  });

  it("rejects an INGEST-kind key on the feedback route with 401 (least privilege)", async () => {
    const res = await sendFeedback(h.ingestPublicKey, {
      kind: "bug",
      message: "wrong key kind",
    });
    expect(res.status).toBe(401);
    expect(await eventsFor(h)).toHaveLength(0);
  });

  it("rejects a FEEDBACK-kind key on the ingest route with 401 (least privilege)", async () => {
    const res = await ingestPOST(
      new Request(`http://test.local/api/ingest/${h.feedbackPublicKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "lead.created",
          occurred_at: new Date().toISOString(),
          idempotency_key: `t:${randomUUID()}`,
          data: {},
        }),
      }),
      { params: Promise.resolve({ publicKey: h.feedbackPublicKey }) },
    );
    expect(res.status).toBe(401);
    // nothing written by the rejected ingest attempt
    expect(await eventsFor(h)).toHaveLength(0);
  });

  it("rejects a body larger than 8KB with 413", async () => {
    const big = "x".repeat(9_000);
    const res = await sendFeedback(h.feedbackPublicKey, {
      kind: "bug",
      message: "padded",
      note: big,
    });
    expect(res.status).toBe(413);
    expect(await eventsFor(h)).toHaveLength(0);
  });

  it("rejects an invalid kind with 400", async () => {
    const res = await sendFeedback(h.feedbackPublicKey, {
      kind: "complaint",
      message: "not one of the five kinds",
    });
    expect(res.status).toBe(400);
    expect(await eventsFor(h)).toHaveLength(0);
  });

  it("rejects a message over 2000 chars with 400", async () => {
    const res = await sendFeedback(h.feedbackPublicKey, {
      kind: "bug",
      message: "y".repeat(2001),
    });
    expect(res.status).toBe(400);
    expect(await eventsFor(h)).toHaveLength(0);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await sendFeedback(h.feedbackPublicKey, "{not json");
    expect(res.status).toBe(400);
    expect(await eventsFor(h)).toHaveLength(0);
  });

  it("rate-limits a burst from a single IP with 429 once the per-IP cap is exceeded", async () => {
    // A fixed IP so every request lands in the SAME per-IP bucket. The first
    // PER_IP_LIMIT requests pass; the next one must be throttled. Distinct
    // messages avoid the idempotency dedup masking the throttle assertion.
    const ip = "198.51.100.7";
    let last: Response | null = null;
    for (let i = 0; i <= PER_IP_LIMIT; i++) {
      last = await sendFeedback(
        h.feedbackPublicKey,
        { kind: "bug", message: `burst ${i}` },
        { ip },
      );
    }
    expect(last!.status).toBe(429);
    expect(await readJson(last!)).toEqual({ error: "rate_limited" });
    expect(last!.headers.get("retry-after")).toBeTruthy();
  });

  it("dedups a double-submit within the same minute to one event + one mirror", async () => {
    const body = {
      kind: "feature" as const,
      message: "Please add SMS confirmations after booking.",
    };
    const ip = "203.0.113.9";
    const r1 = await sendFeedback(h.feedbackPublicKey, body, { ip });
    const r2 = await sendFeedback(h.feedbackPublicKey, body, { ip });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await eventsFor(h)).toHaveLength(1);
    expect(await itemsFor(h)).toHaveLength(1);
  });
});
