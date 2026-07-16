import type { ReactNode } from "react";

/**
 * §4 EmptyState — dashed, 12px, one line + one optional action. Never a giant
 * void: sits inside a card at list-row height. Pure/SSR-safe.
 */
export function EmptyState({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        minHeight: 44,
        padding: "10px 14px",
        border: "1px dashed var(--border-2)",
        borderRadius: 10,
        fontSize: 12.5,
        color: "var(--text-2)",
      }}
    >
      <span>{children}</span>
      {action ? <span style={{ flex: "none" }}>{action}</span> : null}
    </div>
  );
}
