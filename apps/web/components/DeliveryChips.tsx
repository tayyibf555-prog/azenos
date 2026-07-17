import { Pill } from "./system/Pill";
import type { SquircleTone } from "./system/tokens";
import type { BriefStatus } from "./brief-types";

/** RECIPE §3: tinted pill per channel — filled tone = delivered, quiet gray-well = not sent. No border, no bespoke hex. */
function Chip({
  label,
  on,
  tone,
  title,
}: {
  label: string;
  on: boolean;
  tone: SquircleTone;
  title?: string;
}) {
  return (
    <span title={title}>
      {on ? (
        <Pill tone={tone}>
          <span className="dot" style={{ width: 6, height: 6, background: "currentColor" }} aria-hidden />
          {label}
        </Pill>
      ) : (
        <Pill>
          <span className="dot" style={{ width: 6, height: 6, background: "var(--text-3)" }} aria-hidden />
          {label}
        </Pill>
      )}
    </span>
  );
}

const STATUS_TONE: Record<BriefStatus, SquircleTone> = {
  generated: "graphite",
  sent: "mint",
  failed: "rose",
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
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {showStatus && <Pill tone={STATUS_TONE[status] ?? "graphite"}>{status}</Pill>}
      <Chip
        label="Email"
        tone="sky"
        on={Boolean(sentEmailAt)}
        title={sentEmailAt ? `Emailed ${sentEmailAt}` : "Email not sent"}
      />
      <Chip
        label="WhatsApp"
        tone="mint"
        on={Boolean(sentWhatsappAt)}
        title={sentWhatsappAt ? `WhatsApp sent ${sentWhatsappAt}` : "WhatsApp not sent"}
      />
    </div>
  );
}
