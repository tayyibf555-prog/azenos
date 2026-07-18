import { SysIcon, type IconName } from "./icons";
import { TINTS, type SquircleTone } from "./tokens";

/**
 * RECIPE §2/§3 icon backer. Two modes:
 *  - default (on white surfaces — section headers, list-row leadings): a
 *    pastel-tint rounded square with a thin same-hue icon.
 *  - `holder` (inside a tinted container): a near-black rounded-square holder
 *    (#1C1C21, 12px radius + a faint hairline) with the BRIGHT-hue icon — the
 *    DARK-variant of the reference's white-holder signature (a white holder
 *    fails AA against the bright fg icon on a deep wash, so it flips to #1C1C21).
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
        background: holder ? "#1C1C21" : t.bg,
        color: t.fg,
        display: "grid",
        placeItems: "center",
        boxShadow: holder ? "inset 0 0 0 1px rgba(255, 255, 255, 0.08)" : undefined,
      }}
    >
      <SysIcon name={icon} size={size === 32 ? 16 : 15} />
    </span>
  );
}
