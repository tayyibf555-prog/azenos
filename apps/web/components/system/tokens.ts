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
 * DARK VARIANT container tints (RECIPE ## DARK VARIANT, owner-directed
 * 2026-07-17). Each row: `bg` = the whole-card DEEP wash, `fg` = the BRIGHT
 * text/icon, `pill` = the deeper wash for status/countdown pills inside the
 * tinted card. The icon-holder square switches to #1C1C21 on dark (the bright
 * fg icon fails AA on a white holder over a deep wash — see IconSquircle).
 * Exact values from the binding table — do NOT recompute via tint().
 */
export const TINTS: Record<
  SquircleTone,
  { bg: string; fg: string; pill: string }
> = {
  lavender: { bg: "#262040", fg: "#B4A8F5", pill: "#332B55" }, // AI / agents / LLM
  mint: { bg: "#16301F", fg: "#7FD8A3", pill: "#1E402A" }, // money-in / bookings / success
  sky: { bg: "#14283C", fg: "#8CC1F0", pill: "#1B3650" }, // messages / views / sessions
  peach: { bg: "#38261A", fg: "#F0B285", pill: "#4A3222" }, // edits / pending / attention
  rose: { bg: "#3A1F2A", fg: "#F2A3C0", pill: "#4C2938" }, // errors / churn / failures
  butter: { bg: "#332C15", fg: "#E8D48A", pill: "#443B1D" }, // scheduled / waiting / invoices
  graphite: { bg: "#232326", fg: "#B8B8BD", pill: "#2E2E33" }, // system / misc (neutral)
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
