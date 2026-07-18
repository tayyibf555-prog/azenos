import { STEP_LABELS, WIZARD_STEPS, type WizardStep } from "../../lib/onboarding/wizard";

/**
 * Compact numbered step rail. RECIPE T3/T6: ink black is the one structural
 * accent — a done step's circle fills solid black with a white check (the
 * calendar "selected day" mechanic); the active step gets a thin --text ring
 * (the calendar "today" mechanic) and its label reads as a softly elevated
 * white pill (the sidebar "active row" mechanic); upcoming steps stay quiet
 * text with no fill, no border.
 */
export function WizardProgress({ step }: { step: WizardStep }) {
  return (
    <ol
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        margin: 0,
        marginBottom: 22,
        padding: 0,
        listStyle: "none",
        flexWrap: "wrap",
      }}
    >
      {WIZARD_STEPS.map((s, i) => {
        const done = s < step;
        const active = s === step;
        return (
          <li key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              aria-current={active ? "step" : undefined}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "5px 10px 5px 6px",
                borderRadius: "var(--radius-pill)",
                fontSize: 12.5,
                fontWeight: active ? 650 : 500,
                color: active || done ? "var(--text)" : "var(--text-3)",
                background: active ? "#1a1a1f" : "transparent",
                boxShadow: active ? "var(--shadow-card)" : "none",
              }}
            >
              <span
                aria-hidden
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  fontSize: 10.5,
                  fontVariantNumeric: "tabular-nums",
                  color: done ? "var(--on-pill)" : active ? "var(--text)" : "var(--text-3)",
                  background: done ? "var(--pill-active)" : "transparent",
                  boxShadow: active && !done ? "inset 0 0 0 1.5px var(--text)" : "none",
                }}
              >
                {done ? "✓" : s}
              </span>
              {STEP_LABELS[s]}
            </span>
            {i < WIZARD_STEPS.length - 1 && (
              <span
                aria-hidden
                style={{
                  width: 14,
                  height: 1,
                  background: done ? "var(--pill-active)" : "var(--border)",
                }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
