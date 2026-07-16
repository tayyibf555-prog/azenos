import { SysIcon, type IconName } from "./icons";
import { TINTS, type SquircleTone } from "./tokens";

/**
 * §3 signature: a pastel-tint squircle (radius 10) with a thin 1.5px same-hue
 * icon inside. 32px default · 28px in dense lists. Pure/SSR-safe.
 */
export function IconSquircle({
  tone,
  icon,
  size = 32,
}: {
  tone: SquircleTone;
  icon: IconName;
  size?: 28 | 32;
}) {
  const t = TINTS[tone];
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: "none",
        borderRadius: 10,
        background: t.bg,
        color: t.fg,
        display: "grid",
        placeItems: "center",
      }}
    >
      <SysIcon name={icon} size={size === 32 ? 16 : 15} />
    </span>
  );
}
