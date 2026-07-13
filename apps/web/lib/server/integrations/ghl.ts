/**
 * GoHighLevel (GHL) field-mapping preset — spec §6.4, docs/phase6/CONTRACTS.md
 * §P6-SDK-PY.
 *
 * GHL / no-code clients can't run an SDK, so their native workflow webhooks are
 * mapped into the SAME taxonomy event spine (§7) by a per-project mapping config
 * stored on `project_integrations.config` ({ mapping: "ghl-default-v1" }). This
 * module ships the preset as a constant (the stored, human-facing artifact) plus
 * `mapGhlWebhook`, the pure function that applies it: a GHL webhook payload →
 * one taxonomy event envelope (or null when the payload isn't one we map). The
 * result is validated by @azen/events `parseEvent` before it enters the pipeline.
 *
 * Coverage (the four workflow triggers in §6.4):
 *   contact created        → lead.created
 *   appointment booked     → booking.created
 *   pipeline stage changed → lead.stage_changed
 *   form submitted         → form.submitted
 */

export const GHL_DEFAULT_MAPPING_ID = "ghl-default-v1";

export interface GhlMappingRule {
  /** GHL webhook `type` values (case-insensitive) that trigger this rule. */
  ghlTypes: string[];
  /** The taxonomy event type produced. */
  eventType: string;
  /** Human description surfaced in the Setup tab. */
  description: string;
}

export interface GhlMappingPreset {
  id: string;
  version: number;
  description: string;
  rules: GhlMappingRule[];
}

/**
 * The default preset. Stored by id on `project_integrations.config` — the rule
 * list is the documentation; `mapGhlWebhook` is the executable mapping.
 */
export const GHL_DEFAULT_MAPPING_V1: GhlMappingPreset = {
  id: GHL_DEFAULT_MAPPING_ID,
  version: 1,
  description:
    "Maps GoHighLevel workflow webhooks (contact created, appointment booked, pipeline stage changed, form submitted) into Azen OS taxonomy events.",
  rules: [
    {
      ghlTypes: ["ContactCreate", "ContactCreated", "InboundMessage"],
      eventType: "lead.created",
      description: "A new contact in GHL → lead.created (name, email, phone, source).",
    },
    {
      ghlTypes: ["AppointmentCreate", "AppointmentCreated", "AppointmentBooked"],
      eventType: "booking.created",
      description: "A booked appointment → booking.created (service, starts_at, staff).",
    },
    {
      ghlTypes: [
        "OpportunityStageUpdate",
        "OpportunityStageChanged",
        "PipelineStageChanged",
      ],
      eventType: "lead.stage_changed",
      description: "A pipeline stage move → lead.stage_changed (from/to stage, pipeline).",
    },
    {
      ghlTypes: ["FormSubmit", "FormSubmitted", "SurveySubmit"],
      eventType: "form.submitted",
      description: "A form submission → form.submitted (form id/name, fields).",
    },
  ],
};

// ── mapping ───────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** A taxonomy event envelope ready for parseEvent (data validated downstream). */
export interface MappedGhlEvent {
  type: string;
  occurred_at: string;
  idempotency_key: string;
  subject?: { kind: string; id?: string; name?: string };
  data: Json;
}

function asObject(v: unknown): Json | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Json)
    : undefined;
}

/** First present, non-empty string among the given paths. */
function pick(source: Json, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = source[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** Coerce any date-ish value to an ISO-8601 instant; undefined stays undefined. */
function toIso(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function ruleFor(ghlType: string): GhlMappingRule | undefined {
  const t = ghlType.toLowerCase();
  return GHL_DEFAULT_MAPPING_V1.rules.find((r) =>
    r.ghlTypes.some((g) => g.toLowerCase() === t),
  );
}

function fullName(source: Json): string | undefined {
  const explicit = pick(source, "full_name", "fullName", "name", "contact_name");
  if (explicit) return explicit;
  const first = pick(source, "first_name", "firstName");
  const last = pick(source, "last_name", "lastName");
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return joined === "" ? undefined : joined;
}

/**
 * Map a single GHL webhook payload to a taxonomy event envelope, or null if the
 * payload's `type` isn't one this preset covers. Pure + deterministic — the
 * ingest layer validates the result with parseEvent before storing it.
 */
export function mapGhlWebhook(payload: unknown): MappedGhlEvent | null {
  const body = asObject(payload);
  if (!body) return null;
  const ghlType = pick(body, "type", "event_type", "eventType");
  if (!ghlType) return null;
  const rule = ruleFor(ghlType);
  if (!rule) return null;

  const occurredAt =
    toIso(pick(body, "timestamp", "date_created", "dateAdded", "created_at")) ??
    new Date().toISOString();

  const idBase = pick(body, "id", "webhook_id", "event_id") ?? "unknown";

  switch (rule.eventType) {
    case "lead.created": {
      const contactId = pick(body, "contact_id", "contactId", "id");
      const name = fullName(body);
      return {
        type: "lead.created",
        occurred_at: occurredAt,
        idempotency_key: `ghl:contact:${contactId ?? idBase}`,
        subject: { kind: "lead", id: contactId, name },
        data: cleanData({
          name,
          email: pick(body, "email"),
          phone: pick(body, "phone"),
          source: pick(body, "source", "attributionSource"),
          channel: "ghl",
        }),
      };
    }
    case "booking.created": {
      const appt = asObject(body["appointment"]) ?? asObject(body["calendar"]) ?? body;
      const bookingId = pick(appt, "id", "appointment_id", "appointmentId") ?? idBase;
      const startsAt = toIso(
        pick(appt, "startTime", "start_time", "starts_at", "selectedSlot"),
      );
      return {
        type: "booking.created",
        occurred_at: occurredAt,
        idempotency_key: `ghl:appointment:${bookingId}`,
        subject: { kind: "booking", id: bookingId },
        data: cleanData({
          booking_id: bookingId,
          service: pick(appt, "title", "service", "calendarName", "appointment_title"),
          // starts_at is required by the booking.created schema; if GHL didn't
          // supply a parseable time we fall back to the event time.
          starts_at: startsAt ?? occurredAt,
          ends_at: toIso(pick(appt, "endTime", "end_time", "ends_at")),
          staff: pick(appt, "assignedUserId", "staff", "user", "userId"),
          location: pick(appt, "address", "location"),
          channel: "ghl",
        }),
      };
    }
    case "lead.stage_changed": {
      const opp = asObject(body["opportunity"]) ?? body;
      const toStage =
        pick(body, "to_stage", "new_stage", "pipeline_stage") ??
        pick(opp, "stage", "pipelineStageId", "pipeline_stage");
      return {
        type: "lead.stage_changed",
        occurred_at: occurredAt,
        idempotency_key: `ghl:stage:${pick(opp, "id") ?? idBase}:${toStage ?? "unknown"}`,
        subject: { kind: "lead", id: pick(opp, "id", "contact_id") },
        data: cleanData({
          // to_stage is required by the lead.stage_changed schema.
          to_stage: toStage ?? "unknown",
          from_stage: pick(body, "from_stage", "old_stage", "previous_stage"),
          pipeline: pick(body, "pipeline", "pipeline_name") ?? pick(opp, "pipeline", "pipelineId"),
        }),
      };
    }
    case "form.submitted": {
      const formId = pick(body, "form_id", "formId", "id") ?? idBase;
      const fields =
        asObject(body["fields"]) ??
        asObject(body["form_data"]) ??
        asObject(body["formData"]) ??
        {};
      return {
        type: "form.submitted",
        occurred_at: occurredAt,
        idempotency_key: `ghl:form:${formId}:${idBase}`,
        subject: { kind: "lead", id: pick(body, "contact_id", "contactId") },
        data: cleanData({
          form_id: formId,
          form_name: pick(body, "form_name", "formName", "name"),
          fields,
        }),
      };
    }
    default:
      return null;
  }
}

/** Drop undefined-valued keys so optional taxonomy fields stay absent. */
function cleanData(data: Record<string, unknown>): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
