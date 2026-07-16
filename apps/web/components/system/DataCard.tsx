import type { ReactNode } from "react";
import { SectionHeader } from "./SectionHeader";
import type { IconName } from "./icons";
import type { SquircleTone } from "./tokens";

/**
 * §4 DataCard — white card, 14px padding, optional §4 SectionHeader (with a
 * squircle) above the body. The one card wrapper Command Center content lives
 * in. Pure/SSR-safe.
 */
export function DataCard({
  title,
  caption,
  icon,
  tone,
  actions,
  children,
  bodyPad = true,
}: {
  title?: string;
  caption?: string;
  icon?: IconName;
  tone?: SquircleTone;
  actions?: ReactNode;
  children: ReactNode;
  bodyPad?: boolean;
}) {
  return (
    <section
      className="card"
      style={{ padding: 14, display: "grid", gap: title ? 12 : 0 }}
    >
      {title ? (
        <SectionHeader
          title={title}
          caption={caption}
          icon={icon}
          tone={tone}
          actions={actions}
        />
      ) : null}
      <div style={bodyPad ? undefined : { margin: -14, marginTop: 0 }}>
        {children}
      </div>
    </section>
  );
}
