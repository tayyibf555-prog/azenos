/**
 * Shared UI primitives: colour tokens, event-category mapping, status tones.
 * Pure and client-safe — no server-only imports.
 */

export const COLORS = {
  blue: "#7aa2f7",
  violet: "#bb9af7",
  green: "#3fb27f",
  teal: "#2bb6c4",
  magenta: "#e39ff6",
  amber: "#d9a441",
  orange: "#e0955f",
  red: "#f7768e",
  grey: "#8b93a7",
} as const;

export type ColorName = keyof typeof COLORS;

/** Translucent version of a hex colour, for badge/dot fills. */
export function tint(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Category + colour for an event type, keyed off its dotted prefix (spec §7). */
export function eventCategory(type: string): { label: string; color: string } {
  const prefix = type.split(".")[0] ?? "";
  switch (prefix) {
    case "lead":
    case "form":
      return { label: "leads", color: COLORS.blue };
    case "booking":
      return { label: "bookings", color: COLORS.violet };
    case "payment":
    case "invoice":
    case "subscription":
    case "quote":
      return { label: "money", color: COLORS.green };
    case "agent":
      return { label: "agents", color: COLORS.teal };
    case "llm":
      return { label: "llm", color: COLORS.magenta };
    case "message":
    case "email":
    case "call":
    case "review":
      return { label: "comms", color: COLORS.amber };
    case "task":
    case "workflow":
    case "document":
    case "order":
      return { label: "ops", color: COLORS.orange };
    case "system":
    case "integration":
      return { label: "system", color: COLORS.red };
    default:
      return { label: "custom", color: COLORS.grey };
  }
}

const CATEGORY_ORDER = [
  "leads",
  "bookings",
  "money",
  "agents",
  "llm",
  "comms",
  "ops",
  "system",
  "custom",
];

export interface EventTypeGroup {
  label: string;
  color: string;
  types: string[];
}

/** Bucket event types into ordered category groups for the Setup checklist. */
export function groupEventTypes(types: readonly string[]): EventTypeGroup[] {
  const buckets = new Map<string, EventTypeGroup>();
  for (const t of types) {
    const { label, color } = eventCategory(t);
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = { label, color, types: [] };
      buckets.set(label, bucket);
    }
    bucket.types.push(t);
  }
  const ordered: EventTypeGroup[] = [];
  for (const label of CATEGORY_ORDER) {
    const bucket = buckets.get(label);
    if (bucket) ordered.push(bucket);
  }
  return ordered;
}

const STATUS_TONE: Record<string, ColorName> = {
  // project_status
  live: "green",
  building: "blue",
  testing: "violet",
  scoping: "grey",
  paused: "amber",
  completed: "teal",
  cancelled: "red",
  // client_status
  active: "green",
  lead: "grey",
  discovery: "blue",
  proposal: "violet",
  churned: "red",
};

export function statusColor(status: string): string {
  const tone = STATUS_TONE[status];
  return tone ? COLORS[tone] : COLORS.grey;
}

export function healthColor(health: string): string {
  if (health === "green") return COLORS.green;
  if (health === "amber") return COLORS.amber;
  if (health === "red") return COLORS.red;
  return COLORS.grey;
}

/** Human label for an enum-ish slug: "voice_agent" → "Voice agent". */
export function humanize(slug: string): string {
  const spaced = slug.replace(/[_-]+/g, " ").trim();
  const sentence = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return sentence.replace(/\b(ai|crm|ghl|llm|sms|roi)\b/gi, (m) =>
    m.toUpperCase(),
  );
}

/** Compact "key=value" preview of an event's data payload (first few keys). */
export function summarizeData(
  data: Record<string, unknown> | null | undefined,
  maxKeys = 3,
): string {
  if (!data || typeof data !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (parts.length >= maxKeys) break;
    if (value === null || value === undefined) continue;
    let rendered: string;
    if (typeof value === "object") {
      rendered = Array.isArray(value) ? `[${value.length}]` : "{…}";
    } else {
      rendered = String(value);
      if (rendered.length > 32) rendered = `${rendered.slice(0, 31)}…`;
    }
    parts.push(`${key}=${rendered}`);
  }
  return parts.join("  ");
}
