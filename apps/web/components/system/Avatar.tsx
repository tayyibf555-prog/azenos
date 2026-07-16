import { TINTS, avatarTone, initials, type SquircleTone } from "./tokens";

/**
 * §4 Avatar — initials in a pastel tint. Squircle by default (matches list-row
 * IconSquircles); pass `round` for the sidebar-footer circle. Pure/SSR-safe.
 */
export function Avatar({
  name,
  size = 32,
  round = false,
  tone,
}: {
  name: string;
  size?: number;
  round?: boolean;
  tone?: SquircleTone;
}) {
  const t = TINTS[tone ?? avatarTone(name)];
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: "none",
        borderRadius: round ? "50%" : 10,
        background: t.bg,
        color: t.fg,
        display: "grid",
        placeItems: "center",
        fontSize: Math.round(size * 0.4),
        fontWeight: 650,
        letterSpacing: "0.01em",
      }}
    >
      {initials(name)}
    </span>
  );
}
