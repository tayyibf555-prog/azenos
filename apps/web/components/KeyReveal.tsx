"use client";

import type { ReactNode } from "react";
import { CopyBlock } from "./CopyBlock";
import { SnippetTabs } from "./SnippetTabs";
import { COLORS, tint } from "./ui";

/**
 * Reveal-once key material. Shown after project creation and after
 * rotate / revoke — the only moments a secret is ever returned to the client.
 */
export function KeyReveal({
  endpoint,
  publicKey,
  secret,
  authMode,
  showSnippets = true,
  children,
}: {
  endpoint: string;
  publicKey: string;
  secret: string;
  authMode: string;
  showSnippets?: boolean;
  children?: ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: 15 }}>
      <div
        style={{
          padding: "11px 13px",
          borderRadius: "var(--radius-sm)",
          fontSize: 13,
          color: COLORS.amber,
          background: tint(COLORS.amber, 0.1),
          border: `1px solid ${tint(COLORS.amber, 0.3)}`,
        }}
      >
        <strong>Copy the secret now.</strong> It is shown once and cannot be
        retrieved later — only rotated.
      </div>
      <CopyBlock label="Ingest endpoint" value={endpoint} />
      <CopyBlock
        label={`Public key · ${authMode.toUpperCase()} auth`}
        value={publicKey}
      />
      <CopyBlock label="Secret · shown once" value={secret} />
      {showSnippets && (
        <div>
          <div className="label">Drop-in snippets</div>
          <SnippetTabs
            publicKey={publicKey}
            endpoint={endpoint}
            authMode={authMode}
          />
        </div>
      )}
      {children}
    </div>
  );
}
