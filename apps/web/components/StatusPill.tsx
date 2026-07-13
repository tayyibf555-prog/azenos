import { humanize, statusColor, tint } from "./ui";

/** Coloured status pill for project_status / client_status enum values. */
export function StatusPill({ status }: { status: string }) {
  const color = statusColor(status);
  return (
    <span
      className="badge"
      style={{ color, background: tint(color, 0.13), borderColor: tint(color, 0.28) }}
    >
      <span
        className="dot"
        style={{ width: 6, height: 6, background: color }}
        aria-hidden
      />
      {humanize(status)}
    </span>
  );
}
