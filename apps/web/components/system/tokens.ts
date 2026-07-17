/**
 * Design System v3 — shared tokens for the components/system/* library.
 * Pure, client-safe. The single source of the §3 tinted-squircle pairs and the
 * category → tone mapping every chip/row/stat-header uses.
 */
import { eventCategory } from "../ui";

/** Notion tint family — the wash is a WHOLE-container background (RECIPE §2). */
export type SquircleTone =
  | "lavender"
  | "mint"
  | "sky"
  | "peach"
  | "rose"
  | "butter"
  | "graphite";

/**
 * RECIPE §2 pastel container tints. Each row: `bg` = the whole-card wash,
 * `fg` = the deep-hue text/icon, `pill` = the DEEPER wash for status/countdown
 * pills sitting inside the tinted card. The white icon holder is always #FFFFFF.
 * Exact values from the binding table — do NOT recompute via tint().
 */
export const TINTS: Record<
  SquircleTone,
  { bg: string; fg: string; pill: string }
> = {
  lavender: { bg: "#E6E0F5", fg: "#4A3A82", pill: "#D6C9F0" }, // AI / agents / LLM
  mint: { bg: "#D9F3E1", fg: "#1F7A43", pill: "#C3EBD0" }, // money-in / bookings / success
  sky: { bg: "#DCECFA", fg: "#255E9E", pill: "#C7DFF5" }, // messages / views / sessions
  peach: { bg: "#FFE8D4", fg: "#9E5320", pill: "#FBD9BE" }, // edits / pending / attention
  rose: { bg: "#FDE0EC", fg: "#A83464", pill: "#F9CDDE" }, // errors / churn / failures
  butter: { bg: "#FEF7D6", fg: "#8A6D1B", pill: "#F7EBB4" }, // scheduled / waiting / invoices
  graphite: { bg: "#F0EEEC", fg: "#3A3A3C", pill: "#E4E1DE" }, // system / misc (neutral)
};

/** Ordered palette used to colour avatars deterministically by name. */
const AVATAR_TONES: SquircleTone[] = [
  "lavender",
  "sky",
  "mint",
  "peach",
  "butter",
  "rose",
];

/** Category label (from ui.eventCategory) → §3 tone. Reuses the existing map. */
const LABEL_TONE: Record<string, SquircleTone> = {
  leads: "sky",
  bookings: "mint",
  money: "mint",
  agents: "lavender",
  llm: "lavender",
  comms: "peach",
  ops: "graphite",
  system: "graphite",
  custom: "graphite",
};

/** Tone for an event type — leans on ui.eventCategory so the spine mapping stays single-source. */
export function eventTone(type: string): SquircleTone {
  return LABEL_TONE[eventCategory(type).label] ?? "graphite";
}

/** Health colour → tone for StatusDots and health squircles. */
export function healthTone(health: string): SquircleTone {
  if (health === "green") return "mint";
  if (health === "amber") return "butter";
  if (health === "red") return "rose";
  return "graphite";
}

/** Deterministic pastel tone for an avatar, hashed off its label. */
export function avatarTone(seed: string): SquircleTone {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_TONES[Math.abs(h) % AVATAR_TONES.length] ?? "graphite";
}

/** Up-to-two-letter initials from a name ("Acme Co" → "AC", "Tayyib" → "TA"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}
