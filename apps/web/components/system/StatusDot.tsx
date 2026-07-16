import { healthColor, statusColor } from "../ui";

/**
 * §4 StatusDot (+ optional label). Health dot uses healthColor; a generic
 * status slug uses statusColor. Pure/SSR-safe.
 */
export function StatusDot({
  color,
  label,
  size = 8,
}: {
  color: string;
  label?: string;
  size?: number;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontSize: 12.5,
        color: "var(--text-2)",
      }}
    >
      <span
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          flex: "none",
          background: color,
          boxShadow: `0 0 0 3px ${color}22`,
        }}
      />
      {label ? <span style={{ textTransform: "capitalize" }}>{label}</span> : null}
    </span>
  );
}

export function HealthDotLabel({
  health,
  label,
}: {
  health: string;
  label?: string;
}) {
  return <StatusDot color={healthColor(health)} label={label} />;
}

export function StatusDotLabel({ status }: { status: string }) {
  return <StatusDot color={statusColor(status)} label={status} />;
}
