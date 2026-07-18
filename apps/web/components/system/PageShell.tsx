import type { ReactNode } from "react";
import Link from "next/link";
import { SysIcon, type IconName } from "./icons";

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * §2 PageShell — the topbar (breadcrumbs left, right icon-button cluster) that
 * bleeds to the edges of .app-main, plus the max-1280 centered canvas below.
 * Pure/SSR-safe; `actions` receives the client TopbarActions cluster. The
 * bleed margins in .sys-topbar-bleed counteract .app-main's known padding.
 */
export function PageShell({
  crumbs,
  sectionIcon,
  actions,
  children,
}: {
  crumbs: Crumb[];
  sectionIcon?: IconName;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="sys-topbar sys-topbar-bleed">
        <nav className="sys-breadcrumbs" aria-label="Breadcrumb">
          {sectionIcon ? (
            <span style={{ color: "var(--text-2)", display: "inline-flex" }}>
              <SysIcon name={sectionIcon} size={16} strokeWidth={1.6} />
            </span>
          ) : null}
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                {c.href && !last ? (
                  <Link href={c.href} className="sys-crumb">
                    {c.label}
                  </Link>
                ) : (
                  /* Claude editorial: the page name is the masthead — serif
                     display, weight 400, tight tracking (sizing + mobile shrink
                     in .sys-crumb-title). Context crumbs before it stay small
                     sans. */
                  <span
                    className={
                      last
                        ? "sys-crumb sys-crumb-title display-serif"
                        : "sys-crumb"
                    }
                  >
                    {c.label}
                  </span>
                )}
                {!last ? (
                  <span aria-hidden style={{ color: "var(--border-3)", display: "inline-flex" }}>
                    <SysIcon name="chevron" size={13} strokeWidth={1.8} />
                  </span>
                ) : null}
              </span>
            );
          })}
        </nav>
        {actions ? <div style={{ flex: "none" }}>{actions}</div> : null}
      </div>

      <div className="sys-canvas">{children}</div>
    </div>
  );
}
