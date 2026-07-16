import type { ReactNode } from "react";
import { COLORS, tint } from "./ui";

/**
 * Calm inline "activate this feature" notice for agent surfaces whose LLM/embedding
 * key isn't set yet (Phase 7 §D1). The server checks `process.env` and passes plain
 * booleans down as `missing` — this component never reads env itself, client or
 * server. Quiet Glass tone: informational, not alarming (soft royal tint, no
 * amber/red — this isn't an error, it's a setup nudge; everything else still works).
 */
export function ActivationBanner({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;

  const keys: ReactNode[] = [];
  missing.forEach((key, i) => {
    if (i > 0) keys.push(i === missing.length - 1 ? " and " : ", ");
    keys.push(
      <span key={key} className="mono">
        {key}
      </span>,
    );
  });

  return (
    <div
      role="status"
      className="card"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        marginBottom: 16,
        fontSize: 12.5,
        color: "var(--text-2)",
        background: tint(COLORS.blue, 0.06),
        borderColor: tint(COLORS.blue, 0.2),
      }}
    >
      <span
        className="dot"
        style={{ width: 6, height: 6, background: "var(--accent-2)", flex: "none" }}
        aria-hidden
      />
      <span>
        Add {keys} in .env to activate — everything else keeps working.
      </span>
    </div>
  );
}
