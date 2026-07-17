/**
 * Shared UI primitives: colour tokens, event-category mapping, status tones.
 * Pure and client-safe — no server-only imports.
 */

/**
 * Soft-Light palette (APPLE-THEME.md v2). Every value is an icon/line tone that
 * is legible on WHITE. Used two ways:
 *  1. Chart lines & sparklines — drawn directly on white cards.
 *  2. Pastel category chips — `tint(color, ~0.12–0.16)` over white composites to
 *     the spec's pastel washes (lavender/mint/peach/sky/rose/butter); the chip
 *     TEXT is dark (#1D1D1F) and the same-hue tone is the darker icon/accent.
 * Chart-line order (spec): royal → green → slate → warm-gray → muted-amber.
 */
export const COLORS = {
  blue: "#255E9E", // deep sky (RECIPE §2 sky member) — no royal blue; black is the only strong accent
  royalSoft: "#5B54C7", // indigo/periwinkle — lavender chip icon, line tone
  violet: "#6C63C9", // lavender-violet icon tone (agents/AI), legible on white
  green: "#2E9E5B", // positive — deltas, health, money-in; mint chip icon
  teal: "#7C8DB0", // slate — quiet highlight/line on white (was ice-blue)
  magenta: "#A85C93", // muted mauve — desaturated, no neon pink
  amber: "#B98A2E", // muted amber — warn; butter chip icon
  orange: "#C2703A", // muted clay/terracotta — peach chip icon, no neon orange
  red: "#D4524A", // danger — rose chip icon
  grey: "#8E8B87", // warm neutral gray (Apple-warm)
} as const;

export type ColorName = keyof typeof COLORS;

/**
 * Translucent version of a hex colour. On the light theme this is the pastel
 * engine: an icon-tone hex at low alpha over a white surface resolves to the
 * spec's pastel wash — e.g. tint(royalSoft #5B54C7, 0.12) over white ≈ lavender
 * #ECEBFA. Used for chip/dot fills and same-hue hairline borders.
 */
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
      return { label: "bookings", color: COLORS.royalSoft };
    case "payment":
    case "invoice":
    case "subscription":
    case "quote":
      return { label: "money", color: COLORS.green };
    case "agent":
      return { label: "agents", color: COLORS.teal };
    case "llm":
      return { label: "llm", color: COLORS.grey };
    case "message":
    case "email":
    case "call":
    case "review":
      return { label: "comms", color: COLORS.amber };
    case "task":
    case "workflow":
    case "document":
    case "order":
      return { label: "ops", color: COLORS.grey };
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
  return sentence.replace(/\b(ai|crm|llm|sms|roi)\b/gi, (m) =>
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
