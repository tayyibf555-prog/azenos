import { COLORS, tint } from "../ui";
import { STEP_LABELS, WIZARD_STEPS, type WizardStep } from "../../lib/onboarding/wizard";

/** Compact numbered step rail — royal for the active/completed steps, neutral ahead. */
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
        const color = done || active ? COLORS.blue : "var(--text-3)";
        return (
          <li key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              aria-current={active ? "step" : undefined}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "5px 10px 5px 6px",
                borderRadius: 999,
                fontSize: 12.5,
                fontWeight: active ? 650 : 500,
                color: active ? COLORS.blue : done ? "var(--text)" : "var(--text-3)",
                background: active ? tint(COLORS.blue, 0.12) : "transparent",
                border: `1px solid ${active ? tint(COLORS.blue, 0.28) : "var(--border)"}`,
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
                  color: done ? "var(--bg)" : active ? COLORS.blue : "var(--text-3)",
                  background: done ? COLORS.blue : "transparent",
                  border: done ? "none" : `1px solid ${color}`,
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
                  background: done ? COLORS.blue : "var(--border)",
                }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
