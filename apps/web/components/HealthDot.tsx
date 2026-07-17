import { TINTS, healthTone } from "./system";

/** Project health indicator — a coloured dot, optionally labelled. Uses the
 * §2 tinted-container palette (mint/butter/rose) so it reads as the same
 * health language as the grid, badges and stat cards. */
export function HealthDot({
  health,
  showLabel = false,
}: {
  health: string;
  showLabel?: boolean;
}) {
  const t = TINTS[healthTone(health)];
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      title={`Health: ${health}`}
    >
      <span
        className="dot"
        style={{ background: t.fg, boxShadow: `0 0 0 3px ${t.bg}` }}
        aria-hidden
      />
      {showLabel && (
        <span style={{ color: t.fg, fontSize: 12, fontWeight: 550 }}>{health}</span>
      )}
    </span>
  );
}
