"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { CommandPalette } from "./ask/CommandPalette";
import { openAskPalette } from "./ask/paletteEvents";
import { Avatar } from "./system/Avatar";
import { SysIcon, type IconName } from "./system/icons";

interface NavItem {
  label: string;
  href: string;
  icon: IconName;
}

/** §2 sidebar sections: MAIN MENU then WORKSPACE. */
const MAIN_MENU: NavItem[] = [
  { label: "Command Center", href: "/", icon: "grid" },
  { label: "Clients", href: "/clients", icon: "users" },
  { label: "Projects", href: "/projects", icon: "box" },
  { label: "Bookings", href: "/bookings", icon: "calendar" },
  { label: "Money", href: "/money", icon: "pound" },
  { label: "Briefs", href: "/briefs", icon: "doc" },
  { label: "Ask", href: "/ask", icon: "spark" },
];

const WORKSPACE: NavItem[] = [
  { label: "Portfolio", href: "/portfolio", icon: "layers" },
  { label: "Health", href: "/health", icon: "activity" },
  { label: "Growth", href: "/growth", icon: "trending" },
  { label: "Learn", href: "/learn", icon: "book" },
];

export function AppFrame({
  demo,
  children,
}: {
  demo: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();

  // Login and public share links live outside the dashboard chrome.
  if (pathname === "/login" || pathname.startsWith("/share/")) {
    return <>{children}</>;
  }

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const navRow = (item: NavItem) => {
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={active ? "nav-item nav-item-active" : "nav-item"}
      >
        <span style={{ color: active ? "#ffffff" : "var(--text-3)", display: "inline-flex" }}>
          <SysIcon name={item.icon} size={16} strokeWidth={1.6} />
        </span>
        {item.label}
      </Link>
    );
  };

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        {/* brand row */}
        <Link
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "2px 8px 12px",
          }}
        >
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 9,
              background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
              display: "grid",
              placeItems: "center",
              color: "var(--accent-ink)",
              fontWeight: 800,
              fontSize: 14,
            }}
          >
            A
          </span>
          <span style={{ fontSize: 15, fontWeight: 650, letterSpacing: "-0.01em" }}>
            Azen OS
          </span>
        </Link>

        {/* ⌘K Ask field — opens the same palette the keybinding does */}
        <button
          type="button"
          onClick={openAskPalette}
          className="sys-ask-field sidebar-ask"
          aria-label="Ask Azen (Cmd/Ctrl+K)"
        >
          <SysIcon name="search" size={15} strokeWidth={1.6} />
          <span style={{ flex: 1, textAlign: "left" }}>Ask Azen</span>
          <span className="kbd">⌘K</span>
        </button>

        <nav className="app-nav" style={{ marginTop: 4 }}>
          <div className="sys-section-label">Main menu</div>
          {MAIN_MENU.map(navRow)}
          <div className="sys-section-label">Workspace</div>
          {WORKSPACE.map(navRow)}
        </nav>

        {/* shortcuts mini-card — kept, §1-sized */}
        <div
          className="sidebar-shortcuts"
          style={{
            marginTop: "auto",
            padding: "10px",
            borderRadius: 10,
            background: "var(--bg)",
            border: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--text-3)",
              marginBottom: 6,
              letterSpacing: "0.02em",
            }}
          >
            Shortcuts
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <button
              type="button"
              onClick={openAskPalette}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "transparent",
                border: "none",
                padding: "2px 0",
                cursor: "pointer",
                font: "inherit",
                lineHeight: 1.6,
                color: "var(--text-3)",
                fontSize: 11.5,
                textAlign: "left",
              }}
            >
              <span className="kbd">⌘K</span>
              Ask anywhere
            </button>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                lineHeight: 1.6,
                color: "var(--text-3)",
                fontSize: 11.5,
              }}
            >
              <span className="kbd">🎙</span>
              Speak your question
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                lineHeight: 1.6,
                color: "var(--text-3)",
                fontSize: 11.5,
              }}
            >
              <span className="kbd">Esc</span>
              Close
            </div>
          </div>
        </div>

        {/* avatar footer — owner identity */}
        <div className="sys-avatar-footer">
          <Avatar name="Tayyib Arbab" size={28} round tone="lavender" />
          <div style={{ minWidth: 0, lineHeight: 1.3 }}>
            <div
              className="truncate"
              style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}
            >
              Tayyib
            </div>
            <div className="truncate" style={{ fontSize: 11.5, color: "var(--text-3)" }}>
              Owner · Azen AI
            </div>
          </div>
        </div>
      </aside>

      <div className="app-main-col">
        {demo && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 32px",
              fontSize: 12.5,
              color: "var(--amber)",
              background: "rgba(185, 138, 46, 0.09)",
              borderBottom: "1px solid rgba(185, 138, 46, 0.22)",
            }}
          >
            <span
              className="dot"
              style={{ width: 6, height: 6, background: "var(--amber)" }}
              aria-hidden
            />
            Local demo mode — auth disabled. Set SUPABASE_URL / SUPABASE_ANON_KEY
            to activate login.
          </div>
        )}
        <main className="app-main">{children}</main>
      </div>

      {/* Global Ask Azen palette — opens on Cmd/Ctrl-K from any screen. */}
      <CommandPalette />
    </div>
  );
}
