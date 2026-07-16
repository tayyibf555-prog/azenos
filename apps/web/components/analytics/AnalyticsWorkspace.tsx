"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { HealthDot } from "../HealthDot";
import { StatusPill } from "../StatusPill";
import type { AnalyticsProjectView, AnalyticsRange, SectionSlug } from "./types";
import { PulseSection } from "./sections/PulseSection";
import { EngagementSection } from "./sections/EngagementSection";
import { ConversationsAiSection } from "./sections/ConversationsAiSection";
import { FunnelSection } from "./sections/FunnelSection";
import { BookingsSection } from "./sections/BookingsSection";
import { MoneySection } from "./sections/MoneySection";
import { AgentDevSection } from "./sections/AgentDevSection";
import { CustomSection } from "./sections/CustomSection";
import { FeedbackSection } from "./sections/FeedbackSection";
import { ApiCostSection } from "./sections/ApiCostSection";

const RANGES: AnalyticsRange[] = ["7d", "30d", "90d"];

// Phase 9 (P9-COST) adds rail #10 "API Cost" additively — its slug isn't part
// of the foundation SectionSlug union, so the rail keys widen locally here.
type RailSlug = SectionSlug | "api-cost";

interface SectionDef {
  slug: RailSlug;
  label: string;
  hint: string;
  icon: ReactNode;
  Component: (props: { projectId: string; range: AnalyticsRange }) => ReactNode;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
      aria-hidden
    >
      {children}
    </svg>
  );
}

const SECTIONS: SectionDef[] = [
  {
    slug: "pulse",
    label: "Pulse",
    hint: "Overall activity",
    icon: <Icon><path d="M3 12h4l2 6 4-14 2 8h6" /></Icon>,
    Component: PulseSection,
  },
  {
    slug: "engagement",
    label: "Engagement & Usage",
    hint: "When & what fires",
    icon: <Icon><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Icon>,
    Component: EngagementSection,
  },
  {
    slug: "conversations-ai",
    label: "Conversations & AI",
    hint: "Questions & resolution",
    icon: <Icon><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-5A8 8 0 1 1 21 12Z" /></Icon>,
    Component: ConversationsAiSection,
  },
  {
    slug: "funnel",
    label: "Funnel & Conversion",
    hint: "Stage-to-stage flow",
    icon: <Icon><path d="M3 4h18l-7 8v6l-4 2v-8L3 4Z" /></Icon>,
    Component: FunnelSection,
  },
  {
    slug: "bookings",
    label: "Bookings",
    hint: "Appointments & shows",
    icon: <Icon><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v3M16 3v3" /></Icon>,
    Component: BookingsSection,
  },
  {
    slug: "money",
    label: "Money & Value",
    hint: "Revenue & ROI",
    icon: <Icon><path d="M17 6.5A4 4 0 0 0 9 8c0 5-2 6-2 6h9" /><path d="M7 14h8M7 18h9" /></Icon>,
    Component: MoneySection,
  },
  {
    slug: "agent-dev",
    label: "Agent & Dev",
    hint: "Runs, cost, reliability",
    icon: <Icon><path d="m8 6-6 6 6 6M16 6l6 6-6 6" /></Icon>,
    Component: AgentDevSection,
  },
  {
    slug: "custom",
    label: "Custom & Raw",
    hint: "Every event type",
    icon: <Icon><path d="M4 6h16M4 12h16M4 18h10" /></Icon>,
    Component: CustomSection,
  },
  {
    slug: "feedback",
    label: "Feedback",
    hint: "Bugs, requests & praise",
    icon: <Icon><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-5A8 8 0 1 1 21 12Z" /><path d="M9 10h.01M12 10h.01M15 10h.01" /></Icon>,
    Component: FeedbackSection,
  },
  {
    slug: "api-cost",
    label: "API Cost",
    hint: "OS + client spend",
    icon: <Icon><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></Icon>,
    Component: ApiCostSection,
  },
];

export function AnalyticsWorkspace({
  project,
  orgId,
}: {
  project: AnalyticsProjectView;
  /** available for future org-scoped client calls; sections scope via the API */
  orgId: string;
}) {
  void orgId;
  const [active, setActive] = useState<RailSlug>("pulse");
  const [range, setRange] = useState<AnalyticsRange>("30d");

  const current = SECTIONS.find((s) => s.slug === active) ?? SECTIONS[0]!;
  const Section = current.Component;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link
          href={`/projects/${project.id}`}
          className="faint"
          style={{ fontSize: 12.5 }}
        >
          ← {project.name}
        </Link>
      </div>

      {/* top bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ fontSize: 21, fontWeight: 650 }}>Analytics</h1>
            <HealthDot health={project.health} />
            <span className="faint" style={{ fontSize: 13 }}>
              {project.name}
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
            {project.clientName}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "none" }}>
          <StatusPill status={project.status} />
          <RangeControl range={range} onChange={setRange} />
        </div>
      </header>

      {/* rail + canvas — collapses to a single column ≤768px (see .analytics-shell) */}
      <div className="analytics-shell">
        <nav
          className="card analytics-rail"
          style={{
            padding: 8,
            display: "grid",
            gap: 3,
            position: "sticky",
            top: 20,
          }}
          aria-label="Analytics sections"
        >
          {SECTIONS.map((s) => {
            const isActive = s.slug === active;
            return (
              <button
                key={s.slug}
                type="button"
                onClick={() => setActive(s.slug)}
                className={isActive ? "nav-item nav-item-active" : "nav-item"}
                style={{
                  width: "100%",
                  textAlign: "left",
                  cursor: "pointer",
                  background: isActive ? undefined : "transparent",
                }}
                aria-current={isActive ? "page" : undefined}
              >
                {s.icon}
                <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.label}
                  </span>
                  <span className="faint" style={{ fontSize: 11, fontWeight: 500 }}>
                    {s.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        <div style={{ minWidth: 0 }}>
          <Section projectId={project.id} range={range} />
        </div>
      </div>
    </div>
  );
}

function RangeControl({
  range,
  onChange,
}: {
  range: AnalyticsRange;
  onChange: (r: AnalyticsRange) => void;
}) {
  return (
    <div
      className="card"
      style={{ display: "inline-flex", padding: 3, gap: 2, borderRadius: 10 }}
      role="group"
      aria-label="Date range"
    >
      {RANGES.map((r) => {
        const isActive = r === range;
        return (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r)}
            className={isActive ? "nav-item nav-item-active" : "nav-item"}
            style={{
              padding: "5px 12px",
              cursor: "pointer",
              background: isActive ? undefined : "transparent",
              fontSize: 12.5,
            }}
            aria-pressed={isActive}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}
