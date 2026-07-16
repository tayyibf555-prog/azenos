import type { ReactNode } from "react";
import { relativeTime } from "../../lib/format";
import { TINTS, type SquircleTone } from "./tokens";

/**
 * §4 Pill — pill-shaped chip, 32px control height in row context but compact by
 * default. `active` renders the black selection pill; otherwise a quiet gray.
 * Pure/SSR-safe.
 */
export function Pill({
  children,
  active = false,
  tone,
}: {
  children: ReactNode;
  active?: boolean;
  tone?: SquircleTone;
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
          borderRadius: 999,
          fontSize: 11.5,
          fontWeight: 560,
          background: t.bg,
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
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 560,
        background: active ? "var(--black-pill)" : "var(--bg)",
        color: active ? "#fff" : "var(--text-2)",
        border: active ? "1px solid transparent" : "1px solid var(--border)",
      }}
    >
      {children}
    </span>
  );
}

/**
 * §4 CountdownPill — tinted "in 2h" / "in 3d" relative to now, computed at
 * render. Soon (<6h future) reads butter, further out sky, past graphite.
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
