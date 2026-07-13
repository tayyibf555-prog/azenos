import { healthColor, tint } from "./ui";

/** Project health indicator — a coloured dot, optionally labelled. */
export function HealthDot({
  health,
  showLabel = false,
}: {
  health: string;
  showLabel?: boolean;
}) {
  const color = healthColor(health);
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      title={`Health: ${health}`}
    >
      <span
        className="dot"
        style={{ background: color, boxShadow: `0 0 0 3px ${tint(color, 0.16)}` }}
        aria-hidden
      />
      {showLabel && (
        <span style={{ color, fontSize: 12, fontWeight: 550 }}>{health}</span>
      )}
    </span>
  );
}
