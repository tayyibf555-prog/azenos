import { COLORS, tint } from "./ui";
import type { BriefStatus } from "./brief-types";

/** One coloured channel chip: filled = delivered, hollow = not sent. */
function Chip({
  label,
  color,
  on,
  title,
}: {
  label: string;
  color: string;
  on: boolean;
  title?: string;
}) {
  return (
    <span
      className="badge"
      title={title}
      style={{
        color: on ? color : "var(--text-3)",
        background: on ? tint(color, 0.12) : "transparent",
        borderColor: on ? tint(color, 0.28) : "var(--border)",
      }}
    >
      <span
        className="dot"
        style={{ width: 6, height: 6, background: on ? color : "var(--text-3)" }}
        aria-hidden
      />
      {label}
    </span>
  );
}

const STATUS_COLOR: Record<BriefStatus, string> = {
  generated: COLORS.grey,
  sent: COLORS.green,
  failed: COLORS.red,
};

/**
 * Per-channel delivery state for a brief, derived from the sent-at timestamps
 * and status. Pure and server-safe: an overall status pill + one chip/channel.
 */
export function DeliveryChips({
  status,
  sentEmailAt,
  sentWhatsappAt,
  showStatus = true,
}: {
  status: BriefStatus;
  sentEmailAt: string | null;
  sentWhatsappAt: string | null;
  showStatus?: boolean;
}) {
  const statusColor = STATUS_COLOR[status] ?? COLORS.grey;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {showStatus && (
        <span
          className="badge"
          style={{
            color: statusColor,
            background: tint(statusColor, 0.12),
            borderColor: tint(statusColor, 0.28),
          }}
        >
          {status}
        </span>
      )}
      <Chip
        label="Email"
        color={COLORS.blue}
        on={Boolean(sentEmailAt)}
        title={sentEmailAt ? `Emailed ${sentEmailAt}` : "Email not sent"}
      />
      <Chip
        label="WhatsApp"
        color={COLORS.green}
        on={Boolean(sentWhatsappAt)}
        title={sentWhatsappAt ? `WhatsApp sent ${sentWhatsappAt}` : "WhatsApp not sent"}
      />
    </div>
  );
}
