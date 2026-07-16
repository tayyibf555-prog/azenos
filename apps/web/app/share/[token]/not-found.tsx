import { ShareShell } from "./ShareShell";

/**
 * Branded, leak-free 404 for the public share surface (§P8-REPORT). Rendered
 * with an HTTP 404 status whenever the page calls `notFound()` for an unknown /
 * revoked / expired token — a dead or never-valid link must read as 404 to
 * caches, link-preview crawlers and uptime monitors, not as a live 200 page.
 * Copy stays generic: no information about why the link failed leaks.
 */
export default function ShareNotFound() {
  return (
    <ShareShell agencyName="Report">
      <section
        className="card"
        style={{ padding: "40px 28px", display: "grid", gap: 10, textAlign: "center" }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 650, letterSpacing: "-0.01em" }}>
          This link isn&apos;t available
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.6 }}>
          The link may have expired or been turned off. Please ask your contact
          for an up-to-date one.
        </p>
      </section>
    </ShareShell>
  );
}
