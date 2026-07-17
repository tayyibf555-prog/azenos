import { TINTS, avatarTone, initials, type SquircleTone } from "./tokens";

/**
 * §4 Avatar — initials in a pastel tint. RECIPE §3/T6: avatars are CIRCLES by
 * default; pass `round={false}` for the rare squircle. Pure/SSR-safe.
 */
export function Avatar({
  name,
  size = 32,
  round = true,
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
