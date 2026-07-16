import { z } from "zod";
import {
  clientStatus,
  credentialProvider,
  feedbackStatus,
  goodDirection,
  metricAggregation,
  metricUnit,
  projectHealth,
  projectStack,
  projectStatus,
  projectType,
} from "@azen/db";

/**
 * Zod boundaries for the dashboard API (docs/phase1/CONTRACTS.md, workstream
 * C). Enum schemas derive from the drizzle pgEnums so they can never drift
 * from the DB. Limit params CLAMP to their cap ("cap limit at 200") instead
 * of rejecting; empty-string query params are treated as absent because HTML
 * forms send them for untouched filters.
 */

export function searchParamsObject(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams);
}

export function zodSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export const uuidSchema = z.uuid();

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

function limitParam(def: number, cap: number) {
  return z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? String(def) : v),
    z.coerce
      .number()
      .int()
      .positive()
      .transform((n) => Math.min(n, cap)),
  );
}

// ── request bodies ───────────────────────────────────────────────────────────

export const clientCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  industrySlug: z.string().trim().min(1).max(100).optional(),
  status: z.enum(clientStatus.enumValues).optional(),
});
export type ClientCreateInput = z.infer<typeof clientCreateSchema>;

// Connections Vault create body (docs/phase7/PLAN.md §C1). The secret is NOT
// trimmed — surrounding characters are significant to some providers and drive
// last4 — but bounded 8..4096 so an empty/oversize paste is a clean 400. The
// label is a short human note. `provider` derives from the DB enum so it can
// never drift from credential_provider.
export const credentialCreateSchema = z.object({
  provider: z.enum(credentialProvider.enumValues),
  label: z.string().trim().min(1).max(60),
  secret: z.string().min(8).max(4096),
});
export type CredentialCreateInput = z.infer<typeof credentialCreateSchema>;

export const projectCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(projectType.enumValues),
    stack: z.enum(projectStack.enumValues).optional(),
    description: z.string().trim().max(2000).optional(),
    retainerPenceMonthly: z.number().int().nonnegative().optional(),
    buildFeePence: z.number().int().nonnegative().optional(),
    hourlyRatePence: z.number().int().positive().max(100_000).optional(),
    goals: z
      .array(
        z.object({
          metric: z.string().trim().min(1).max(100),
          target: z.number().finite(),
          period: z.enum(["day", "week", "month"]),
        }),
      )
      .max(10)
      .optional(),
    clientId: uuidSchema.optional(),
    newClient: z
      .object({
        name: z.string().trim().min(1).max(200),
        industrySlug: z.string().trim().min(1).max(100).optional(),
      })
      .optional(),
  })
  .refine((v) => (v.clientId === undefined) !== (v.newClient === undefined), {
    message: "provide exactly one of clientId or newClient",
  });
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

export const projectPatchSchema = z
  .object({
    status: z.enum(projectStatus.enumValues).optional(),
    health: z.enum(projectHealth.enumValues).optional(),
    description: z.string().trim().max(2000).optional(),
    retainerPenceMonthly: z.number().int().nonnegative().optional(),
    retainerActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "at least one field required",
  });
export type ProjectPatchInput = z.infer<typeof projectPatchSchema>;

// ── query params ─────────────────────────────────────────────────────────────

const isoInstantOrDate = z.iso.datetime({ offset: true }).or(z.iso.date());

export const tickerQuerySchema = z.object({
  afterId: z.preprocess(emptyToUndefined, uuidSchema.optional()),
  limit: limitParam(30, 100),
});
export type TickerQuery = z.infer<typeof tickerQuerySchema>;

export const projectEventsQuerySchema = z.object({
  type: z.preprocess(emptyToUndefined, z.string().max(128).optional()),
  q: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  from: z.preprocess(emptyToUndefined, isoInstantOrDate.optional()),
  to: z.preprocess(emptyToUndefined, isoInstantOrDate.optional()),
  limit: limitParam(50, 200),
  cursor: z.preprocess(emptyToUndefined, z.string().optional()),
});
export type ProjectEventsQuery = z.infer<typeof projectEventsQuerySchema>;

export const deliveriesQuerySchema = z.object({
  limit: limitParam(50, 200),
});
export type DeliveriesQuery = z.infer<typeof deliveriesQuerySchema>;

// ── keyset cursor: base64("<occurredAt ISO>|<event uuid>") ──────────────────

export interface EventsCursor {
  occurredAt: Date;
  id: string;
}

export function encodeEventsCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`, "utf8").toString(
    "base64",
  );
}

export function decodeEventsCursor(cursor: string): EventsCursor | null {
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const sep = decoded.indexOf("|");
  if (sep === -1) return null;
  const occurredAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(occurredAt.getTime()) || !isUuid(id)) return null;
  return { occurredAt, id };
}

// ── M2 (wave 2): metrics / ROI / insights / costs (docs/phase2/CONTRACTS.md) ──
// Appended per M2 ownership (append-only additions to schemas.ts).

/** metric_definitions.key wire format (contract POST body): ^[a-z][a-z0-9_]{1,48}$ */
export const METRIC_KEY_RE = /^[a-z][a-z0-9_]{1,48}$/;
export const metricKeySchema = z.string().regex(METRIC_KEY_RE);

/** Body for POST /metrics and POST /metrics/preview (identical shape). */
export const metricDefinitionInputSchema = z.object({
  key: metricKeySchema,
  name: z.string().trim().min(1).max(120),
  description: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().trim().max(500).optional(),
  ),
  unit: z.enum(metricUnit.enumValues),
  aggregation: z.enum(metricAggregation.enumValues),
  eventType: z.string().trim().min(1).max(128),
  valuePath: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.string().trim().max(200).optional(),
  ),
  whereEquals: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .nullable()
    .optional(),
  goodDirection: z.enum(goodDirection.enumValues).optional(),
  isKpi: z.boolean().optional(),
});
export type MetricDefinitionInput = z.infer<typeof metricDefinitionInputSchema>;

const isoDate = z.iso.date();
/** YYYY-MM (London month). */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

export const metricSeriesQuerySchema = z.object({
  keys: z.preprocess(
    (v) => (typeof v === "string" ? v : ""),
    z
      .string()
      .transform((s) =>
        Array.from(
          new Set(
            s
              .split(",")
              .map((k) => k.trim())
              .filter((k) => k.length > 0),
          ),
        ),
      )
      .refine((arr) => arr.length >= 1 && arr.length <= 12, {
        message: "provide 1..12 metric keys",
      }),
  ),
  period: z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? "day" : v),
    z.enum(["hour", "day", "week", "month"]),
  ),
  from: z.preprocess(emptyToUndefined, isoDate.optional()),
  to: z.preprocess(emptyToUndefined, isoDate.optional()),
  compare: z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? "none" : v),
    z.enum(["previous", "none"]),
  ),
});
export type MetricSeriesQuery = z.infer<typeof metricSeriesQuerySchema>;

export const monthQuerySchema = z.object({
  month: z.preprocess(emptyToUndefined, monthSchema.optional()),
});
export type MonthQuery = z.infer<typeof monthQuerySchema>;

export const insightsQuerySchema = z.object({
  status: z.preprocess(
    emptyToUndefined,
    z
      .enum(["new", "reviewed", "actioned", "dismissed", "converted_to_upsell"])
      .optional(),
  ),
  limit: limitParam(20, 100),
});
export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

export const insightPatchSchema = z.object({
  status: z.enum(["reviewed", "dismissed"]),
});
export type InsightPatchInput = z.infer<typeof insightPatchSchema>;

// Phase 7 §B2 — triage board status transitions (new → seen → planned → done).
export const feedbackStatusPatchSchema = z.object({
  status: z.enum(feedbackStatus.enumValues),
});
export type FeedbackStatusPatchInput = z.infer<
  typeof feedbackStatusPatchSchema
>;

export const sparklinesQuerySchema = z.object({
  days: z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? "7" : v),
    z.coerce
      .number()
      .int()
      .positive()
      .transform((n) => Math.min(n, 90)),
  ),
});
export type SparklinesQuery = z.infer<typeof sparklinesQuerySchema>;
