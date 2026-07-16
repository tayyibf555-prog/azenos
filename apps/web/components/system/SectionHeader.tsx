import type { ReactNode } from "react";
import { IconSquircle } from "./IconSquircle";
import type { IconName } from "./icons";
import type { SquircleTone } from "./tokens";

/**
 * §4 SectionHeader — title 15px/620 with optional leading squircle, a quiet
 * caption, and right-aligned actions. Pure/SSR-safe.
 */
export function SectionHeader({
  title,
  caption,
  icon,
  tone = "graphite",
  actions,
}: {
  title: string;
  caption?: string;
  icon?: IconName;
  tone?: SquircleTone;
  actions?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minHeight: 32,
      }}
    >
      {icon ? <IconSquircle tone={tone} icon={icon} size={28} /> : null}
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, minWidth: 0 }}>
        <h3
          style={{
            fontSize: 15,
            fontWeight: 620,
            letterSpacing: "-0.015em",
            color: "var(--text)",
          }}
        >
          {title}
        </h3>
        {caption ? (
          <span className="faint" style={{ fontSize: 12 }}>
            {caption}
          </span>
        ) : null}
      </div>
      {actions ? (
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>{actions}</div>
      ) : null}
    </div>
  );
}
