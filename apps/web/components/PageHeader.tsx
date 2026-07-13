import type { ReactNode } from "react";

/** Consistent page title block with optional subtitle and right-aligned actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        marginBottom: 24,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 22, fontWeight: 650 }}>{title}</h1>
        {subtitle && (
          <p className="muted" style={{ fontSize: 13.5, marginTop: 5 }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div style={{ flex: "none", display: "flex", gap: 10 }}>{actions}</div>
      )}
    </header>
  );
}
