import { z } from "zod";

/**
 * Common event envelope — spec §7.
 * Every event carries: type, occurred_at, idempotency_key, and optionally
 * actor, subject, data, value_pence, currency (default gbp), minutes_saved.
 * `value_pence` + `minutes_saved` are the ROI atoms.
 */

// Accepts "2026-07-11T09:00:00Z" and offset forms like "2026-07-11T10:00:00+01:00"
export const isoTimestamp = z.iso.datetime({ offset: true });

export const actorSchema = z.object({
  kind: z.enum(["ai_agent", "human", "system"]),
  id: z.string().max(255).optional(),
  name: z.string().max(255).optional(),
});

export const subjectSchema = z.object({
  // Open set: lead|customer|booking|order|patient|... — client systems know best
  kind: z.string().min(1).max(64),
  id: z.string().max(255).optional(),
  name: z.string().max(255).optional(),
});

export const currencySchema = z
  .string()
  .regex(/^[a-zA-Z]{3}$/, "currency must be a 3-letter ISO code")
  .transform((s) => s.toLowerCase());

export const envelopeBaseSchema = z.object({
  type: z.string().min(1).max(128),
  occurred_at: isoTimestamp,
  idempotency_key: z.string().min(1).max(255),
  actor: actorSchema.optional(),
  subject: subjectSchema.optional(),
  value_pence: z.number().int().optional(),
  currency: currencySchema.default("gbp"),
  minutes_saved: z.number().nonnegative().max(60 * 24 * 365).optional(),
});

export type Actor = z.infer<typeof actorSchema>;
export type Subject = z.infer<typeof subjectSchema>;
export type EnvelopeBase = z.infer<typeof envelopeBaseSchema>;
