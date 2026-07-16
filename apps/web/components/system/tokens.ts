/**
 * Design System v3 — shared tokens for the components/system/* library.
 * Pure, client-safe. The single source of the §3 tinted-squircle pairs and the
 * category → tone mapping every chip/row/stat-header uses.
 */
import { eventCategory } from "../ui";

/** §3 signature: pastel-tint background + same-hue darker icon/text. */
export type SquircleTone =
  | "lavender"
  | "mint"
  | "sky"
  | "peach"
  | "rose"
  | "butter"
  | "graphite";

/** Exact §3 tint/icon-hue pairs — hardcoded washes (NOT computed via tint()). */
export const TINTS: Record<SquircleTone, { bg: string; fg: string }> = {
  lavender: { bg: "#ECEBFA", fg: "#5B54C7" }, // AI, agents, LLM
  mint: { bg: "#DFF3E6", fg: "#1F7A43" }, // success, money-in, bookings, present
  sky: { bg: "#DDEBF9", fg: "#2B6CB0" }, // messages, views, info, sessions
  peach: { bg: "#FBEBDD", fg: "#B05C2A" }, // edits, warnings, pending-attention
  rose: { bg: "#F9E3E1", fg: "#B0433A" }, // errors, absence, failures
  butter: { bg: "#FBF3D9", fg: "#8A6D1B" }, // scheduled, waiting, invoices
  graphite: { bg: "#ECECF1", fg: "#3A3A3C" }, // system, misc
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
