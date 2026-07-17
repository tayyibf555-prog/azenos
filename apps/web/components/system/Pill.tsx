import type { ReactNode } from "react";
import { relativeTime } from "../../lib/format";
import { TINTS, type SquircleTone } from "./tokens";

/**
 * RECIPE §3 Pill — always pill radius. A `tone` renders a pastel-wash chip with
 * deep-hue text; `deep` swaps to the DEEPER wash (`TINTS[tone].pill`) for pills
 * that sit INSIDE a tinted card. Without a tone, `active` renders the black
 * selection pill (ink); otherwise a quiet gray-well pill. Pure/SSR-safe.
 */
export function Pill({
  children,
  active = false,
  tone,
  deep = false,
}: {
  children: ReactNode;
  active?: boolean;
  tone?: SquircleTone;
  deep?: boolean;
}) {
  if (tone) {
    const t = TINTS[tone];
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 22,
          padding: "0 10px",
          borderRadius: 9999,
          fontSize: 11.5,
          fontWeight: 560,
          background: deep ? t.pill : t.bg,
          color: t.fg,
        }}
      >
        {children}
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 22,
        padding: "0 10px",
        borderRadius: 9999,
        fontSize: 11.5,
        fontWeight: 560,
        background: active ? "var(--pill-active)" : "var(--bg-well)",
        color: active ? "var(--on-pill)" : "var(--text-2)",
      }}
    >
      {children}
    </span>
  );
}

/**
 * §4 CountdownPill — tinted "in 2h" / "in 3d" relative to now, computed at
 * render. Soon (<6h future) reads butter, further out sky, past graphite. When
 * placed inside a tinted card, prefer EventChip's own same-hue countdown; this
 * standalone variant is for white-surface contexts.
 */
export function CountdownPill({ target }: { target: string | number | Date }) {
  const t = new Date(target).getTime();
  const now = Date.now();
  const future = t > now;
  const hours = (t - now) / 3_600_000;
  const tone: SquircleTone = !future
    ? "graphite"
    : hours <= 6
      ? "butter"
      : "sky";
  return <Pill tone={tone}>{relativeTime(target, now)}</Pill>;
}
