import type { ReactNode } from "react";
import { relativeTime } from "../../lib/format";
import { IconSquircle } from "./IconSquircle";
import { Pill } from "./Pill";
import type { IconName } from "./icons";
import { TINTS, eventTone, type SquircleTone } from "./tokens";

/**
 * RECIPE §3 tinted event/content card — the reference's signature. The WHOLE
 * card is one pastel wash (§2 tint table) at tile radius with zero border; the
 * wash itself is the separation from white siblings. Inside sits a WHITE
 * rounded-square icon holder, deep-hue title + muted-deep meta, and — when a
 * `countdownTarget` is given — a deeper-wash countdown pill in the SAME hue.
 * Pass an explicit `tone`/`icon`, or an event `type` to derive the §2 tone.
 * Pure/SSR-safe.
 */
export function EventChip({
  title,
  time,
  type,
  tone,
  icon = "spark",
  meta,
  countdownTarget,
}: {
  title: ReactNode;
  time?: ReactNode;
  type?: string;
  tone?: SquircleTone;
  icon?: IconName;
  meta?: ReactNode;
  countdownTarget?: string | number | Date;
}) {
  const resolved: SquircleTone = tone ?? (type ? eventTone(type) : "graphite");
  const t = TINTS[resolved];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        minHeight: 52,
        padding: "11px 12px",
        borderRadius: "var(--radius-tile)",
        background: t.bg,
      }}
      className="sys-eventchip"
    >
      <IconSquircle tone={resolved} icon={icon} size={32} holder />
      <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 2 }}>
        <span
          className="truncate"
          style={{ fontSize: 13.5, fontWeight: 600, color: t.fg }}
        >
          {title}
        </span>
        {time ? (
          <span
            className="truncate"
            style={{ fontSize: 11.5, fontWeight: 500, color: t.fg, opacity: 0.72 }}
          >
            {time}
          </span>
        ) : null}
      </span>
      {countdownTarget != null ? (
        <span style={{ flex: "none" }}>
          <Pill tone={resolved} deep>
            {relativeTime(countdownTarget, Date.now())}
          </Pill>
        </span>
      ) : meta ? (
        <span style={{ flex: "none" }}>{meta}</span>
      ) : null}
    </div>
  );
}
