import { randomUUID } from "node:crypto";
import {
  alertRules,
  bookings,
  closeDb,
  db,
  events,
  insights,
  projectKeys,
  webhookDeliveries,
} from "@azen/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupHarness,
  createHarness,
  ensureFreshRateWindow,
  makeEvent,
  readJson,
  sendIngest,
  sleep,
  waitFor,
  type Harness,
} from "./helpers";

interface IngestResponse {
  accepted: number;
  duplicates: number;
  rejected: { index: number; reason: string }[];
}

const deliveriesFor = (h: Harness) =>
  db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.projectKeyId, h.keyId));

describe("POST /api/ingest/[publicKey]", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await cleanupHarness(h);
    await closeDb();
  });

  it("accepts a signed single event and reacts after the response", async () => {
    const event = makeEvent("lead.created", {
      subject: { kind: "lead", name: "Jane B" },
      data: { name: "Jane B", source: "test" },
    });
    const res = await sendIngest(h, event);
    expect(res.status).toBe(200);
    expect(await readJson<IngestResponse>(res)).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [],
    });

    const [row] = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.orgId, h.orgId),
          eq(events.idempotencyKey, String(event.idempotency_key)),
        ),
      );
    expect(row).toBeDefined();
    expect(row!.type).toBe("lead.created");
    expect(row!.source).toBe("sdk");
    expect(row!.projectId).toBe(h.projectId);
    expect((row!.raw as Record<string, unknown>).idempotency_key).toBe(
      event.idempotency_key,
    );

    const accepted = (await deliveriesFor(h)).filter(
      (d) => d.status === "accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.eventId).toBe(row!.id);
    expect(accepted[0]!.httpStatus).toBe(200);
    expect(accepted[0]!.raw).toBeNull();

    // step 10 reaction: last_used_at stamped after the response
    await waitFor(async () => {
      const [key] = await db
        .select({ lastUsedAt: projectKeys.lastUsedAt })
        .from(projectKeys)
        .where(eq(projectKeys.id, h.keyId));
      return key?.lastUsedAt;
    });
  });

  it("counts an identical resend as a duplicate", async () => {
    const event = makeEvent("lead.created", { data: { name: "Dup" } });
    await sendIngest(h, event);
    const res = await sendIngest(h, event);
    expect(res.status).toBe(200);
    expect(await readJson<IngestResponse>(res)).toEqual({
      accepted: 0,
      duplicates: 1,
      rejected: [],
    });
    const dupes = (await deliveriesFor(h)).filter(
      (d) => d.status === "duplicate",
    );
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.eventId).toBeNull();
  });

  it("rejects a tampered signature with a generic 401 and a dead-letter row", async () => {
    const before = (await deliveriesFor(h)).length;
    const res = await sendIngest(h, makeEvent("lead.created"), {
      secretOverride: `azn_sk_wrong_${randomUUID().replaceAll("-", "")}`,
    });
    expect(res.status).toBe(401);
    expect(await readJson(res)).toEqual({ error: "unauthorized" });

    const rows = await deliveriesFor(h);
    expect(rows).toHaveLength(before + 1);
    const rejectedRow = rows.find((d) => d.error === "signature mismatch");
    expect(rejectedRow).toBeDefined();
    expect(rejectedRow!.status).toBe("rejected");
    expect(rejectedRow!.httpStatus).toBe(401);
    expect(rejectedRow!.raw).not.toBeNull();
  });

  it("rejects a stale signature timestamp", async () => {
    const res = await sendIngest(h, makeEvent("lead.created"), {
      timestampS: Math.floor(Date.now() / 1000) - 600,
    });
    expect(res.status).toBe(401);
    const stale = (await deliveriesFor(h)).find(
      (d) => d.error === "signature stale",
    );
    expect(stale).toBeDefined();
    expect(stale!.status).toBe("rejected");
  });

  it("authenticates token-mode keys and stores source sdk", async () => {
    const tokenHarness = await createHarness({ authMode: "token" });
    try {
      const event = makeEvent("form.submitted", {
        data: { form_name: "Quote" },
      });
      const ok = await sendIngest(tokenHarness, event);
      expect(ok.status).toBe(200);
      expect((await readJson<IngestResponse>(ok)).accepted).toBe(1);
      const [row] = await db
        .select({ source: events.source })
        .from(events)
        .where(
          and(
            eq(events.orgId, tokenHarness.orgId),
            eq(events.idempotencyKey, String(event.idempotency_key)),
          ),
        );
      expect(row!.source).toBe("sdk");

      const bad = await sendIngest(tokenHarness, makeEvent("form.submitted"), {
        token: "azn_sk_not_the_secret",
      });
      expect(bad.status).toBe(401);
      expect(await readJson(bad)).toEqual({ error: "unauthorized" });
      const rejectedRow = (await deliveriesFor(tokenHarness)).find(
        (d) => d.error === "token mismatch",
      );
      expect(rejectedRow).toBeDefined();
    } finally {
      await cleanupHarness(tokenHarness);
    }
  });

  it("accepts unknown event types remapped to custom.*", async () => {
    const event = makeEvent("Shopify Order Synced!", {
      data: { order: "so_1" },
    });
    const res = await sendIngest(h, event);
    expect((await readJson<IngestResponse>(res)).accepted).toBe(1);
    const [row] = await db
      .select({ type: events.type, raw: events.raw })
      .from(events)
      .where(
        and(
          eq(events.orgId, h.orgId),
          eq(events.idempotencyKey, String(event.idempotency_key)),
        ),
      );
    expect(row!.type).toBe("custom.shopify_order_synced");
    // raw keeps the pre-normalization payload
    expect((row!.raw as Record<string, unknown>).type).toBe(
      "Shopify Order Synced!",
    );
  });

  it("rejects known types with invalid data and keeps raw on the delivery", async () => {
    const bad = makeEvent("booking.created", { data: { service: "Checkup" } });
    const res = await sendIngest(h, bad);
    expect(res.status).toBe(200);
    const body = await readJson<IngestResponse>(res);
    expect(body.accepted).toBe(0);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.index).toBe(0);
    expect(body.rejected[0]!.reason).toContain("starts_at");

    const rejectedRow = (await deliveriesFor(h)).find(
      (d) => d.status === "rejected" && d.error?.includes("starts_at"),
    );
    expect(rejectedRow).toBeDefined();
    expect(rejectedRow!.raw).not.toBeNull();
  });

  it("accepts mixed batches and reports per-index rejections", async () => {
    const good = makeEvent("lead.created", { data: { name: "Mixed" } });
    const bad = makeEvent("booking.created", { data: {} });
    const res = await sendIngest(h, { events: [good, bad] });
    const body = await readJson<IngestResponse>(res);
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(0);
    expect(body.rejected).toEqual([
      { index: 1, reason: expect.stringContaining("starts_at") },
    ]);
    const mixed = (await deliveriesFor(h)).find(
      (d) => d.status === "accepted" && d.error?.startsWith("1 rejected:"),
    );
    expect(mixed).toBeDefined();
  });

  it("mirrors booking.created into bookings and flips status on cancel", async () => {
    const startsAt = new Date(Date.now() + 48 * 3_600_000);
    startsAt.setUTCMilliseconds(0);
    const created = makeEvent("booking.created", {
      subject: { kind: "customer", id: "cus_t1", name: "Jane Doe" },
      value_pence: 4500,
      data: {
        booking_id: "bk_mirror_1",
        service: "Checkup",
        starts_at: startsAt.toISOString(),
        channel: "voice",
      },
    });
    const res = await sendIngest(h, created);
    expect((await readJson<IngestResponse>(res)).accepted).toBe(1);

    const [eventRow] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.orgId, h.orgId),
          eq(events.idempotencyKey, String(created.idempotency_key)),
        ),
      );
    const [booking] = await db
      .select()
      .from(bookings)
      .where(
        and(eq(bookings.orgId, h.orgId), eq(bookings.externalId, "bk_mirror_1")),
      );
    expect(booking).toBeDefined();
    expect(booking!.kind).toBe("client_end_customer");
    expect(booking!.source).toBe("client_system");
    expect(booking!.status).toBe("scheduled");
    expect(booking!.projectId).toBe(h.projectId);
    expect(booking!.clientId).toBe(h.clientId);
    expect(booking!.sourceEventId).toBe(eventRow!.id);
    expect(booking!.startsAt.toISOString()).toBe(startsAt.toISOString());
    expect(booking!.endsAt!.getTime()).toBe(startsAt.getTime() + 30 * 60_000);
    expect((booking!.invitee as Record<string, unknown>).name).toBe("Jane Doe");

    const cancelled = makeEvent("booking.cancelled", {
      data: { booking_id: "bk_mirror_1", reason: "patient unwell" },
    });
    await sendIngest(h, cancelled);
    const [after] = await db
      .select({ status: bookings.status })
      .from(bookings)
      .where(
        and(eq(bookings.orgId, h.orgId), eq(bookings.externalId, "bk_mirror_1")),
      );
    expect(after!.status).toBe("cancelled");
  });

  it("skips lifecycle events whose booking_id matches nothing", async () => {
    const before = await db
      .select()
      .from(bookings)
      .where(eq(bookings.orgId, h.orgId));
    const res = await sendIngest(
      h,
      makeEvent("booking.cancelled", { data: { booking_id: "bk_ghost" } }),
    );
    expect((await readJson<IngestResponse>(res)).accepted).toBe(1);
    const after = await db
      .select()
      .from(bookings)
      .where(eq(bookings.orgId, h.orgId));
    expect(after).toHaveLength(before.length);
  });

  it("rejects oversize payloads with 413 and no delivery row", async () => {
    const before = (await deliveriesFor(h)).length;
    const res = await sendIngest(h, null, {
      rawBody: JSON.stringify(
        makeEvent("custom.big", { data: { blob: "x".repeat(263_000) } }),
      ),
    });
    expect(res.status).toBe(413);
    expect(await readJson(res)).toEqual({ error: "payload_too_large" });
    expect((await deliveriesFor(h)).length).toBe(before);
  });

  it("rejects batches over 100 events", async () => {
    const res = await sendIngest(h, {
      events: Array.from({ length: 101 }, () => makeEvent("lead.created")),
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({ error: "batch_too_large" });
    const row = (await deliveriesFor(h)).find(
      (d) => d.error === "batch_too_large",
    );
    expect(row).toBeDefined();
    expect(row!.status).toBe("rejected");
    expect(row!.raw).not.toBeNull();
  });

  it("dead-letters unparseable JSON", async () => {
    const res = await sendIngest(h, null, { rawBody: "{not json" });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({ error: "invalid_json" });
    const row = (await deliveriesFor(h)).find(
      (d) => d.error === "invalid_json",
    );
    expect(row).toBeDefined();
    expect(row!.status).toBe("rejected");
    expect(row!.raw).toBe("{not json");
  });

  it("returns 401 for unknown public keys without logging a delivery", async () => {
    const res = await sendIngest(
      { ...h, publicKey: `azn_pk_test_${randomUUID()}` },
      makeEvent("lead.created"),
    );
    expect(res.status).toBe(401);
    expect(await readJson(res)).toEqual({ error: "unauthorized" });
  });

  it("rate limits the 4th request in a 10s window with Retry-After", async () => {
    const limited = await createHarness({ rateLimitPer10s: 3 });
    try {
      await ensureFreshRateWindow();
      for (let i = 0; i < 3; i++) {
        const ok = await sendIngest(limited, makeEvent("lead.created"));
        expect(ok.status).toBe(200);
      }
      const res = await sendIngest(limited, makeEvent("lead.created"));
      expect(res.status).toBe(429);
      expect(await readJson(res)).toEqual({ error: "rate_limited" });
      const retryAfter = Number(res.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(10);

      const row = (await deliveriesFor(limited)).find(
        (d) => d.error === "rate_limited",
      );
      expect(row).toBeDefined();
      expect(row!.status).toBe("rejected");
      expect(row!.httpStatus).toBe(429);
      expect(row!.raw).toBeNull();
    } finally {
      await cleanupHarness(limited);
    }
  });

  it("fires an error_streak alert into insights once per cooldown", async () => {
    const [rule] = await db
      .insert(alertRules)
      .values({
        orgId: h.orgId,
        projectId: null, // org-wide default, applied per project
        kind: "error_streak",
        condition: { event_type: "system.error", count: 3, window_minutes: 30 },
        channel: "whatsapp",
        cooldownMinutes: 120,
        enabled: true,
      })
      .returning({ id: alertRules.id });

    const batch = Array.from({ length: 3 }, (_, i) =>
      makeEvent("system.error", {
        data: { severity: "error", component: "quote-generator", message: `boom ${i}` },
      }),
    );
    const res = await sendIngest(h, batch);
    expect((await readJson<IngestResponse>(res)).accepted).toBe(3);

    const insight = await waitFor(async () => {
      const [row] = await db
        .select()
        .from(insights)
        .where(eq(insights.orgId, h.orgId));
      return row;
    });
    expect(insight.kind).toBe("anomaly");
    expect(insight.confidence).toBe("high");
    expect(insight.status).toBe("new");
    expect(insight.createdBy).toBe("agent");
    expect(insight.projectId).toBe(h.projectId);
    expect(insight.title).toBe(`${h.projectName}: 3 system.error events in 30m`);
    expect(insight.bodyMd).toContain("boom");
    expect(
      (insight.evidence as { event_ids: string[] }).event_ids,
    ).toHaveLength(3);

    const [firedRule] = await db
      .select({ lastFiredAt: alertRules.lastFiredAt })
      .from(alertRules)
      .where(eq(alertRules.id, rule!.id));
    expect(firedRule!.lastFiredAt).not.toBeNull();

    // within cooldown: another error must not create a second insight
    await sendIngest(
      h,
      makeEvent("system.error", { data: { message: "boom again" } }),
    );
    await sleep(800);
    const all = await db
      .select({ id: insights.id })
      .from(insights)
      .where(eq(insights.orgId, h.orgId));
    expect(all).toHaveLength(1);
  });
});
