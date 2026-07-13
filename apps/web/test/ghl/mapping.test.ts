import { describe, expect, it } from "vitest";
import { parseEvent } from "@azen/events";
import {
  GHL_DEFAULT_MAPPING_ID,
  GHL_DEFAULT_MAPPING_V1,
  mapGhlWebhook,
} from "../../lib/server/integrations/ghl";

/**
 * GHL field-mapping preset (§P6-SDK-PY). The mandatory guard: each of the four
 * §6.4 GHL workflow webhooks (contact created, appointment booked, pipeline
 * stage changed, form submitted) maps to a taxonomy event that PASSES parseEvent
 * — the same taxonomy gate the ingest pipeline uses. If the mapping ever emits a
 * shape the taxonomy rejects, these fail.
 */

function expectValid(payload: unknown, expectedType: string) {
  const mapped = mapGhlWebhook(payload);
  expect(mapped, `mapped ${expectedType}`).not.toBeNull();
  expect(mapped!.type).toBe(expectedType);
  const parsed = parseEvent(mapped);
  if (!parsed.ok) {
    throw new Error(
      `parseEvent rejected ${expectedType}: ${parsed.error} ${JSON.stringify(parsed.issues ?? [])}`,
    );
  }
  return parsed.event;
}

describe("ghl-default-v1 preset", () => {
  it("exposes the expected id and rule coverage", () => {
    expect(GHL_DEFAULT_MAPPING_V1.id).toBe(GHL_DEFAULT_MAPPING_ID);
    const produced = GHL_DEFAULT_MAPPING_V1.rules.map((r) => r.eventType).sort();
    expect(produced).toEqual([
      "booking.created",
      "form.submitted",
      "lead.created",
      "lead.stage_changed",
    ]);
  });

  it("maps a contact-created webhook to a valid lead.created", () => {
    const ev = expectValid(
      {
        type: "ContactCreate",
        id: "contact_abc",
        first_name: "Zoë",
        last_name: "Smith",
        email: "zoe@example.com",
        phone: "+447700900000",
        source: "facebook_ad",
        date_created: "2026-07-12T09:30:00Z",
      },
      "lead.created",
    );
    expect(ev.data["name"]).toBe("Zoë Smith");
    expect(ev.data["email"]).toBe("zoe@example.com");
    expect(ev.data["source"]).toBe("facebook_ad");
    expect(ev.idempotency_key).toBe("ghl:contact:contact_abc");
  });

  it("maps an appointment-booked webhook to a valid booking.created", () => {
    const ev = expectValid(
      {
        type: "AppointmentCreate",
        id: "hook_1",
        appointment: {
          id: "appt_123",
          title: "Checkup",
          startTime: "2026-07-14T10:00:00Z",
          endTime: "2026-07-14T10:30:00Z",
          assignedUserId: "user_9",
          address: "12 High St",
        },
        timestamp: "2026-07-12T09:31:00Z",
      },
      "booking.created",
    );
    expect(ev.data["service"]).toBe("Checkup");
    expect(ev.data["starts_at"]).toBe("2026-07-14T10:00:00.000Z");
    expect(ev.data["staff"]).toBe("user_9");
    expect(ev.idempotency_key).toBe("ghl:appointment:appt_123");
  });

  it("maps a pipeline-stage-change webhook to a valid lead.stage_changed", () => {
    const ev = expectValid(
      {
        type: "OpportunityStageUpdate",
        opportunity: { id: "opp_5", pipeline: "Sales" },
        from_stage: "New Lead",
        to_stage: "Booked",
        date_created: "2026-07-12T11:00:00Z",
      },
      "lead.stage_changed",
    );
    expect(ev.data["to_stage"]).toBe("Booked");
    expect(ev.data["from_stage"]).toBe("New Lead");
    expect(ev.data["pipeline"]).toBe("Sales");
  });

  it("maps a form-submit webhook to a valid form.submitted", () => {
    const ev = expectValid(
      {
        type: "FormSubmit",
        id: "sub_77",
        form_id: "form_contact",
        form_name: "Contact us",
        contact_id: "contact_abc",
        fields: { budget: "£5k", message: "Need a quote" },
      },
      "form.submitted",
    );
    expect(ev.data["form_id"]).toBe("form_contact");
    expect(ev.data["form_name"]).toBe("Contact us");
    expect(ev.data["fields"]).toEqual({ budget: "£5k", message: "Need a quote" });
  });

  it("returns null for an unmapped GHL webhook type", () => {
    expect(mapGhlWebhook({ type: "SomethingElse", id: "x" })).toBeNull();
    expect(mapGhlWebhook({ id: "no-type" })).toBeNull();
    expect(mapGhlWebhook(null)).toBeNull();
    expect(mapGhlWebhook("not-an-object")).toBeNull();
  });

  it("falls back to the event time when an appointment omits a start time", () => {
    // starts_at is required by the booking.created schema — the mapping must
    // still produce a parseable event (fallback to occurred_at).
    const ev = expectValid(
      { type: "AppointmentBooked", id: "appt_x", timestamp: "2026-07-12T09:30:00Z" },
      "booking.created",
    );
    expect(ev.data["starts_at"]).toBe("2026-07-12T09:30:00.000Z");
  });
});
