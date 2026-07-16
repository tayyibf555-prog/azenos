import type { ReactNode } from "react";

/**
 * White-label chrome for every public share surface (monthly report today, sent
 * proposal once P8-GROWTH2 lands). Full-bleed, calm glass, mobile-perfect, and
 * deliberately anonymous: it shows the AGENCY name only — never Azen branding,
 * org ids, or internal navigation. Rendered outside the dashboard AppFrame
 * (see AppFrame's /share bypass).
 */
export function ShareShell({
  agencyName,
  eyebrow,
  children,
}: {
  agencyName: string;
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(1200px 600px at 50% -10%, rgba(52,87,213,0.10), transparent 60%), var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--sans)",
        padding: "clamp(20px, 5vw, 56px) 20px 72px",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ width: "100%", maxWidth: 760, display: "grid", gap: 24 }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            paddingBottom: 4,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              background:
                "linear-gradient(135deg, var(--accent), var(--accent-2))",
              color: "var(--accent-ink)",
              fontWeight: 800,
              fontSize: 14,
              flex: "none",
            }}
          >
            {(agencyName.trim()[0] ?? "A").toUpperCase()}
          </span>
          <div style={{ display: "grid", gap: 1 }}>
            <span
              style={{ fontSize: 15.5, fontWeight: 650, letterSpacing: "-0.01em" }}
            >
              {agencyName}
            </span>
            {eyebrow && (
              <span style={{ fontSize: 12, color: "var(--text-3)" }}>
                {eyebrow}
              </span>
            )}
          </div>
        </header>

        {children}

        <footer
          style={{
            marginTop: 8,
            paddingTop: 16,
            borderTop: "1px solid var(--border)",
            fontSize: 11.5,
            color: "var(--text-3)",
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>Prepared by {agencyName}</span>
          <span>Private link — please don&apos;t share publicly</span>
        </footer>
      </div>
    </div>
  );
}
