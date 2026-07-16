import type { CSSProperties } from "react";
import { Markdown } from "../../../components/Markdown";
import { formatPence } from "../../../lib/format";
import type { SharedProposalDoc } from "../../../lib/server/growth";
import { ShareShell } from "./ShareShell";

const sectionLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 650,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-3)",
  marginBottom: 8,
};

/**
 * Public, white-label proposal document (docs/phase8/CONTRACTS.md
 * §P8-GROWTH2) — the artifact a "Send" on the Growth board resolves to.
 * Reuses P8-REPORT's `ShareShell` chrome and the shared, dependency-free
 * `Markdown` renderer. Only client-ready copy + price ever reach this
 * surface — no org ids, insight ids, or evidence payload.
 */
export function ProposalDoc({ proposal }: { proposal: SharedProposalDoc }) {
  return (
    <ShareShell agencyName={proposal.agencyName} eyebrow="Proposal">
      <section style={{ display: "grid", gap: 6 }}>
        <h1
          style={{
            fontSize: "clamp(22px, 4vw, 30px)",
            fontWeight: 680,
            letterSpacing: "-0.02em",
            lineHeight: 1.15,
          }}
        >
          {proposal.title}
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--text-2)" }}>
          Prepared for {proposal.clientName}.
        </p>
      </section>

      {proposal.suggestedPricePence !== null && (
        <section
          className="card"
          style={{
            padding: "16px 18px",
            display: "flex",
            alignItems: "baseline",
            gap: 10,
          }}
        >
          <span
            className="tnum"
            style={{ fontSize: 26, fontWeight: 680, letterSpacing: "-0.02em" }}
          >
            {formatPence(proposal.suggestedPricePence)}
          </span>
          <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>
            proposed investment
          </span>
        </section>
      )}

      <section
        className="card"
        style={{ padding: "22px 24px", display: "grid", gap: 18 }}
      >
        <div>
          <h2 style={sectionLabel}>The opportunity</h2>
          <Markdown source={proposal.problemMd} />
        </div>
        <div>
          <h2 style={sectionLabel}>What we&apos;d build</h2>
          <Markdown source={proposal.proposalMd} />
        </div>
      </section>
    </ShareShell>
  );
}
