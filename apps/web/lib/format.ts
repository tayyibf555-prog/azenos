/**
 * Shared display formatters (UI workstream). London timezone + integer-pence
 * money, per Phase 1 contract. Pure, dependency-free, safe in client bundles.
 */

function toDate(input: Date | string | number): Date {
  return input instanceof Date ? input : new Date(input);
}

/** £ with thousands separators. Pence dropped when the amount is whole pounds. */
export function formatPence(pence: number | null | undefined): string {
  const n = typeof pence === "number" && Number.isFinite(pence) ? pence : 0;
  const hasFraction = n % 100 !== 0;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 0,
  }).format(n / 100);
}

const londonDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const londonDateTimeSeconds = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const londonDateOnly = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/** e.g. "12 Jul 2026, 14:03" (append seconds with withSeconds). */
export function formatLondonTime(
  input: Date | string | number,
  withSeconds = false,
): string {
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) return "—";
  return (withSeconds ? londonDateTimeSeconds : londonDateTime).format(d);
}

/** e.g. "12 Jul 2026". */
export function formatLondonDate(input: Date | string | number): string {
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) return "—";
  return londonDateOnly.format(d);
}

/** Compact relative time: "just now", "3s ago", "5m ago", "2h ago", "3d ago". */
export function relativeTime(
  input: Date | string | number,
  now: number = Date.now(),
): string {
  const d = toDate(input);
  const t = d.getTime();
  if (Number.isNaN(t)) return "—";
  const deltaSec = Math.round((t - now) / 1000);
  const past = deltaSec <= 0;
  const s = Math.abs(deltaSec);
  const suffix = (val: number, unit: string) =>
    past ? `${val}${unit} ago` : `in ${val}${unit}`;
  if (s < 5) return "just now";
  if (s < 60) return suffix(s, "s");
  const m = Math.floor(s / 60);
  if (m < 60) return suffix(m, "m");
  const h = Math.floor(m / 60);
  if (h < 24) return suffix(h, "h");
  const days = Math.floor(h / 24);
  if (days < 7) return suffix(days, "d");
  const w = Math.floor(days / 7);
  if (w < 5) return suffix(w, "w");
  const mo = Math.floor(days / 30);
  if (mo < 12) return suffix(mo, "mo");
  return suffix(Math.floor(days / 365), "y");
}

/** Whole days elapsed since a timestamp (used for the "silent Nd" badge). */
export function daysSince(
  input: Date | string | number,
  now: number = Date.now(),
): number {
  const t = toDate(input).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((now - t) / 86_400_000);
}
