import type { ReactNode } from "react";
import Link from "next/link";

/**
 * §4 ListRow — 44px row: leading squircle/avatar · primary 13.5px + secondary
 * 12px muted · right meta/pill. Hairline separators + #FAFAFC hover live in the
 * enclosing .sys-list (see globals.css). Optionally a link. Pure/SSR-safe.
 */
export function ListRow({
  leading,
  primary,
  secondary,
  meta,
  href,
}: {
  leading?: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  meta?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      {leading ? <span style={{ flex: "none" }}>{leading}</span> : null}
      <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 1 }}>
        <span
          className="truncate"
          style={{ fontSize: 13.5, fontWeight: 550, color: "var(--text)" }}
        >
          {primary}
        </span>
        {secondary ? (
          <span
            className="truncate"
            style={{ fontSize: 12, color: "var(--text-2)" }}
          >
            {secondary}
          </span>
        ) : null}
      </span>
      {meta ? (
        <span
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {meta}
        </span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className="sys-listrow">
        {body}
      </Link>
    );
  }
  return <div className="sys-listrow">{body}</div>;
}

/** Container that draws the hairline separators + hover between ListRows. */
export function List({ children }: { children: ReactNode }) {
  return <div className="sys-list">{children}</div>;
}
