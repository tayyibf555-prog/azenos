import type { ReactNode } from "react";
import { TINTS } from "./system/tokens";

/**
 * Calm inline "activate this feature" notice for agent surfaces whose LLM/embedding
 * key isn't set yet (Phase 7 §D1). The server checks `process.env` and passes plain
 * booleans down as `missing` — this component never reads env itself, client or
 * server. RECIPE §3 tinted-container tone: informational sky wash, no amber/red —
 * this isn't an error, it's a setup nudge; everything else still works.
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
        color: TINTS.sky.fg,
        background: TINTS.sky.bg,
        boxShadow: "none",
      }}
    >
      <span
        className="dot"
        style={{ width: 6, height: 6, background: TINTS.sky.fg, flex: "none" }}
        aria-hidden
      />
      <span>
        Add {keys} in .env to activate — everything else keeps working.
      </span>
    </div>
  );
}
