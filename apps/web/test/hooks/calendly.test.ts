import { bookings, closeDb, db, webhookDeliveries } from "@azen/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  calendlyEvent,
  cleanupHookHarness,
  createHookHarness,
  postCalendly,
  readJson,
  type HookHarness,
} from "./helpers";

describe("POST /api/hooks/calendly", () => {
  let h: HookHarness;

  beforeAll(async () => {
    h = await createHookHarness();
  });
  afterAll(async () => {
    await cleanupHookHarness(h);
    await closeDb();
  });

  it("creates a scheduled booking on invitee.created with kind mapping", async () => {
    const uri = "https://api.calendly.com/scheduled_events/e1/invitees/i1";
    const res = await postCalendly(
      calendlyEvent({ inviteeUri: uri, eventName: "Kickoff Call" }),
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).bookingCreated).toBe(true);

    const rows = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.orgId, h.orgId), eq(bookings.externalId, uri)));
    expect(rows).toHaveLength(1);
    // "Kickoff Call" → kind kickoff; agency booking has no client/project
    expect(rows[0]!.kind).toBe("kickoff");
    expect(rows[0]!.source).toBe("calendly");
    expect(rows[0]!.status).toBe("scheduled");
    expect(rows[0]!.clientId).toBeNull();
    expect(rows[0]!.projectId).toBeNull();
  });

  it("defaults unrecognised event-type names to discovery", async () => {
    const uri = "https://api.calendly.com/scheduled_events/e2/invitees/i2";
    await postCalendly(
      calendlyEvent({ inviteeUri: uri, eventName: "Intro Chat" }),
    );
    const [row] = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.orgId, h.orgId), eq(bookings.externalId, uri)));
    expect(row!.kind).toBe("discovery");
  });

  it("flips the booking to cancelled on invitee.canceled", async () => {
    const uri = "https://api.calendly.com/scheduled_events/e3/invitees/i3";
    await postCalendly(calendlyEvent({ inviteeUri: uri, eventName: "Review" }));
    const res = await postCalendly(
      calendlyEvent({ type: "invitee.canceled", inviteeUri: uri }),
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).bookingCancelled).toBe(true);

    const [row] = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.orgId, h.orgId), eq(bookings.externalId, uri)));
    expect(row!.kind).toBe("review");
    expect(row!.status).toBe("cancelled");
  });

  it("rejects a bad signature with 400 and a rejected delivery", async () => {
    const uri = "https://api.calendly.com/scheduled_events/e4/invitees/i4";
    const res = await postCalendly(calendlyEvent({ inviteeUri: uri }), {
      secret: "wrong_secret",
    });
    expect(res.status).toBe(400);
    const rows = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.orgId, h.orgId), eq(bookings.externalId, uri)));
    expect(rows).toHaveLength(0);

    const rejected = (
      await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.orgId, h.orgId))
    ).find((d) => d.status === "rejected" && d.error === "signature mismatch");
    expect(rejected).toBeDefined();
    expect(rejected!.raw).not.toBeNull();
  });

  it("is idempotent: the same invitee.created twice → one booking", async () => {
    const uri = "https://api.calendly.com/scheduled_events/e5/invitees/i5";
    const first = await postCalendly(calendlyEvent({ inviteeUri: uri }));
    expect((await readJson(first)).bookingCreated).toBe(true);
    const second = await postCalendly(calendlyEvent({ inviteeUri: uri }));
    expect((await readJson(second)).duplicate).toBe(true);
    const rows = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.orgId, h.orgId), eq(bookings.externalId, uri)));
    expect(rows).toHaveLength(1);
  });

  it("ignores unrelated Calendly event types with a 200", async () => {
    const res = await postCalendly({
      event: "routing_form_submission.created",
      payload: { uri: "https://api.calendly.com/x" },
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).ignored).toBe(true);
  });

  it("concurrent duplicate invitee.created → exactly one booking", async () => {
    const uri = "https://api.calendly.com/scheduled_events/e6/invitees/i6";
    const event = calendlyEvent({ inviteeUri: uri });
    await Promise.all([postCalendly(event), postCalendly(event)]);
    const rows = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.orgId, h.orgId), eq(bookings.externalId, uri)));
    expect(rows).toHaveLength(1);
  });
});
