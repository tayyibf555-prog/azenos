"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { CommandPalette } from "./ask/CommandPalette";

interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      aria-hidden
      style={{ flex: "none" }}
      {...stroke}
    >
      {children}
    </svg>
  );
}

const NAV: NavItem[] = [
  {
    label: "Command Center",
    href: "/",
    icon: (
      <Icon>
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </Icon>
    ),
  },
  {
    label: "Clients",
    href: "/clients",
    icon: (
      <Icon>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
        <path d="M16 5.5a3 3 0 0 1 0 5.6" />
        <path d="M20.5 20a5.5 5.5 0 0 0-4-5.3" />
      </Icon>
    ),
  },
  {
    label: "Projects",
    href: "/projects",
    icon: (
      <Icon>
        <path d="M21 8 12 3 3 8l9 5 9-5Z" />
        <path d="M3 8v8l9 5 9-5V8" />
        <path d="M12 13v8" />
      </Icon>
    ),
  },
  {
    label: "Bookings",
    href: "/bookings",
    icon: (
      <Icon>
        <rect x="3" y="4.5" width="18" height="16" rx="2" />
        <path d="M3 9h18M8 3v3M16 3v3" />
      </Icon>
    ),
  },
  {
    label: "Money",
    href: "/money",
    icon: (
      <Icon>
        <path d="M17 6.5A4 4 0 0 0 9 8c0 5-2 6-2 6h9" />
        <path d="M7 14h8" />
        <path d="M7 18h9" />
      </Icon>
    ),
  },
  {
    label: "Briefs",
    href: "/briefs",
    icon: (
      <Icon>
        <path d="M6 3h8l4 4v14H6Z" />
        <path d="M14 3v4h4" />
        <path d="M9 13h6M9 17h6" />
      </Icon>
    ),
  },
  {
    label: "Ask",
    href: "/ask",
    icon: (
      <Icon>
        <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-5A8 8 0 1 1 21 12Z" />
      </Icon>
    ),
  },
  {
    label: "Growth",
    href: "/growth",
    icon: (
      <Icon>
        <path d="M4 19V5" />
        <path d="M4 15l5-5 4 3 6-7" />
        <path d="M19 9V6h-3" />
      </Icon>
    ),
  },
  {
    label: "Learn",
    href: "/learn",
    icon: (
      <Icon>
        <path d="M4 5.5A2 2 0 0 1 6 4h6v15H6a2 2 0 0 0-2 1.5Z" />
        <path d="M20 5.5A2 2 0 0 0 18 4h-6v15h6a2 2 0 0 1 2 1.5Z" />
      </Icon>
    ),
  },
];

export function AppFrame({
  demo,
  children,
}: {
  demo: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();

  // Login lives outside the dashboard chrome.
  if (pathname === "/login") {
    return <>{children}</>;
  }

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          position: "fixed",
          insetBlock: 0,
          left: 0,
          width: "var(--sidebar-w)",
          background: "var(--panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          padding: "18px 12px",
          zIndex: 10,
        }}
      >
        <Link
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "4px 8px 18px",
          }}
        >
          <span
            style={{
              width: 24,
              height: 24,
              borderRadius: 7,
              background: "linear-gradient(135deg, #7aa2f7, #bb9af7)",
              display: "grid",
              placeItems: "center",
              color: "#0b0e14",
              fontWeight: 800,
              fontSize: 13,
            }}
          >
            A
          </span>
          <span style={{ fontSize: 15, fontWeight: 650, letterSpacing: "-0.01em" }}>
            Azen OS
          </span>
        </Link>

        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 9px",
                  borderRadius: 7,
                  fontSize: 13.5,
                  fontWeight: 550,
                  color: active ? "var(--text)" : "var(--text-2)",
                  background: active ? "var(--card-2)" : "transparent",
                }}
              >
                <span style={{ color: active ? "var(--accent)" : "var(--text-3)" }}>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div
          style={{
            marginTop: "auto",
            padding: "10px 9px 2px",
            fontSize: 11,
            color: "var(--text-3)",
          }}
        >
          Phase 6 · Growth &amp; Learn
        </div>
      </aside>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          marginLeft: "var(--sidebar-w)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {demo && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 32px",
              fontSize: 12.5,
              color: "#d9a441",
              background: "rgba(217, 164, 65, 0.08)",
              borderBottom: "1px solid rgba(217, 164, 65, 0.2)",
            }}
          >
            <span
              className="dot"
              style={{ width: 6, height: 6, background: "#d9a441" }}
              aria-hidden
            />
            Local demo mode — auth disabled. Set SUPABASE_URL / SUPABASE_ANON_KEY
            to activate login.
          </div>
        )}
        <main style={{ flex: 1, padding: "28px 32px", minWidth: 0 }}>
          {children}
        </main>
      </div>

      {/* Global Ask Azen palette — opens on Cmd/Ctrl-K from any screen. */}
      <CommandPalette />
    </div>
  );
}
