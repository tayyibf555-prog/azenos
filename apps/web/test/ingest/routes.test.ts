import { randomUUID } from "node:crypto";
import { closeDb, db, events, webhookDeliveries } from "@azen/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanupHarness,
  createHarness,
  makeEvent,
  readJson,
  sendIngest,
  type Harness,
} from "./helpers";

// requireOrgId resolves the demo org in local mode; point it at the
// throwaway test org instead by faking an authenticated session user.
const mockAuth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("../../lib/supabase", () => ({
  supabaseConfigured: () => true,
  getSessionUser: async () =>
    mockAuth.userId ? { id: mockAuth.userId } : null,
}));

import { POST as replayPOST } from "../../app/api/deliveries/[deliveryId]/replay/route";
import { POST as testEventPOST } from "../../app/api/projects/[projectId]/test-event/route";

interface IngestResponse {
  accepted: number;
  duplicates: number;
  rejected: { index: number; reason: string }[];
  eventType?: string;
}

const callTestEvent = (projectId: string) =>
  testEventPOST(
    new Request(`http://test.local/api/projects/${projectId}/test-event`, {
      method: "POST",
    }),
    { params: Promise.resolve({ projectId }) },
  );

const callReplay = (deliveryId: string) =>
  replayPOST(
    new Request(`http://test.local/api/deliveries/${deliveryId}/replay`, {
      method: "POST",
    }),
    { params: Promise.resolve({ deliveryId }) },
  );

describe("test-event and replay routes", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    mockAuth.userId = h.userId;
  });

  afterAll(async () => {
    await cleanupHarness(h);
    await closeDb();
  });

  it("sends a signed custom.azen_test event through the real pipeline", async () => {
    const res = await callTestEvent(h.projectId);
    expect(res.status).toBe(200);
    const body = await readJson<IngestResponse>(res);
    expect(body).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [],
      eventType: "custom.azen_test",
    });

    const [row] = await db
      .select()
      .from(events)
      .where(
        and(eq(events.orgId, h.orgId), eq(events.type, "custom.azen_test")),
      );
    expect(row).toBeDefined();
    expect(row!.source).toBe("sdk");
    expect(row!.idempotencyKey.startsWith("test:")).toBe(true);
    expect(row!.data).toEqual({ note: "Sent from the Setup tab" });
  });

  it("uses the token header for token-mode keys", async () => {
    const tokenHarness = await createHarness({ authMode: "token" });
    mockAuth.userId = tokenHarness.userId;
    try {
      const res = await callTestEvent(tokenHarness.projectId);
      expect(res.status).toBe(200);
      expect((await readJson<IngestResponse>(res)).accepted).toBe(1);
      const [row] = await db
        .select({ source: events.source })
        .from(events)
        .where(
          and(
            eq(events.orgId, tokenHarness.orgId),
            eq(events.type, "custom.azen_test"),
          ),
        );
      expect(row!.source).toBe("sdk");
    } finally {
      mockAuth.userId = h.userId;
      await cleanupHarness(tokenHarness);
    }
  });

  it("404s test-event for projects outside the caller's org", async () => {
    const other = await createHarness();
    try {
      expect((await callTestEvent(randomUUID())).status).toBe(404);
      expect((await callTestEvent(other.projectId)).status).toBe(404);
    } finally {
      await cleanupHarness(other);
    }
  });

  it("replays a rejected delivery once the sender-side problem is fixed", async () => {
    // dead-letter a valid payload behind a bad signature
    const event = makeEvent("lead.created", { data: { name: "Replay Me" } });
    const first = await sendIngest(h, event, {
      secretOverride: `azn_sk_wrong_${randomUUID().replaceAll("-", "")}`,
    });
    expect(first.status).toBe(401);
    const original = (
      await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.orgId, h.orgId))
    ).find((d) => d.error === "signature mismatch");
    expect(original).toBeDefined();

    const res = await callReplay(original!.id);
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

    const replayRow = (
      await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.orgId, h.orgId))
    ).find((d) => d.error === `replay of ${original!.id}`);
    expect(replayRow).toBeDefined();
    expect(replayRow!.status).toBe("accepted");
    expect(replayRow!.eventId).toBe(row!.id);

    // replaying again dedups against the first replay
    const again = await callReplay(original!.id);
    expect(again.status).toBe(200);
    expect((await readJson<IngestResponse>(again)).duplicates).toBe(1);
  });

  it("409s when the delivery kept no raw payload", async () => {
    const event = makeEvent("lead.created", { data: { name: "Accepted" } });
    await sendIngest(h, event);
    const accepted = (
      await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.orgId, h.orgId))
    ).find((d) => d.status === "accepted" && d.eventId !== null);
    expect(accepted).toBeDefined();
    const res = await callReplay(accepted!.id);
    expect(res.status).toBe(409);
    expect(await readJson(res)).toEqual({ error: "nothing_to_replay" });
  });

  it("404s replays of deliveries outside the caller's org", async () => {
    const other = await createHarness();
    try {
      await sendIngest(other, makeEvent("lead.created"), {
        secretOverride: `azn_sk_wrong_${randomUUID().replaceAll("-", "")}`,
      });
      const foreign = (
        await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.orgId, other.orgId))
      ).find((d) => d.status === "rejected");
      expect(foreign).toBeDefined();
      expect((await callReplay(foreign!.id)).status).toBe(404);
      expect((await callReplay(randomUUID())).status).toBe(404);
    } finally {
      await cleanupHarness(other);
    }
  });

  it("401s both routes without a session", async () => {
    mockAuth.userId = null;
    try {
      expect((await callTestEvent(h.projectId)).status).toBe(401);
      expect((await callReplay(randomUUID())).status).toBe(401);
    } finally {
      mockAuth.userId = h.userId;
    }
  });
});
