import type { ReactNode } from "react";
import { IconSquircle } from "./IconSquircle";
import type { IconName } from "./icons";
import { eventTone, type SquircleTone } from "./tokens";

/**
 * §4 EventChip — tinted card row: leading squircle + 13px/600 title + 11.5px
 * muted time. 32–36px tall. Used by the ticker, activity feeds and calendars.
 * Pass an explicit `tone`/`icon`, or an event `type` to derive the §3 tone.
 * Pure/SSR-safe.
 */
export function EventChip({
  title,
  time,
  type,
  tone,
  icon = "spark",
  meta,
}: {
  title: ReactNode;
  time?: ReactNode;
  type?: string;
  tone?: SquircleTone;
  icon?: IconName;
  meta?: ReactNode;
}) {
  const resolved: SquircleTone = tone ?? (type ? eventTone(type) : "graphite");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minHeight: 36,
        padding: "5px 8px",
        borderRadius: 10,
      }}
      className="sys-eventchip"
    >
      <IconSquircle tone={resolved} icon={icon} size={28} />
      <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 1 }}>
        <span
          className="truncate"
          style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}
        >
          {title}
        </span>
        {time ? (
          <span className="faint" style={{ fontSize: 11.5 }}>
            {time}
          </span>
        ) : null}
      </span>
      {meta ? <span style={{ flex: "none" }}>{meta}</span> : null}
    </div>
  );
}
