import { SysIcon, type IconName } from "./icons";
import { TINTS, type SquircleTone } from "./tokens";

/**
 * RECIPE §2/§3 icon backer. Two modes:
 *  - default (on white surfaces — section headers, list-row leadings): a
 *    pastel-tint rounded square with a thin same-hue icon.
 *  - `holder` (inside a tinted container): a WHITE rounded-square holder
 *    (12px radius + whisper shadow) with the deep-hue icon — the reference's
 *    signature inside every tinted event/content card.
 * 32px default · 28px in dense lists. Pure/SSR-safe.
 */
export function IconSquircle({
  tone,
  icon,
  size = 32,
  holder = false,
}: {
  tone: SquircleTone;
  icon: IconName;
  size?: 28 | 32;
  holder?: boolean;
}) {
  const t = TINTS[tone];
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: "none",
        borderRadius: holder ? "var(--radius-icon)" : 10,
        background: holder ? "#FFFFFF" : t.bg,
        color: t.fg,
        display: "grid",
        placeItems: "center",
        boxShadow: holder ? "0 1px 2px rgba(0, 0, 0, 0.06)" : undefined,
      }}
    >
      <SysIcon name={icon} size={size === 32 ? 16 : 15} />
    </span>
  );
}
