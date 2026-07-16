import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PulseBody, type PulseData } from "../../components/analytics/sections/PulseSection";

/**
 * P9-W0A — numbers-first render check: PulseBody (fed hand-built data
 * directly, bypassing the fetch hook) must render its StatTile numbers
 * immediately, and must NOT render any chart/SVG markup until an
 * ExpandableChart is opened (all default-closed on first render).
 */

const DATA: PulseData = {
  range: "30d",
  from: "2026-06-17",
  to: "2026-07-16",
  totalEvents: 842,
  activeDays: 27,
  series: [
    { periodStart: "2026-07-14T00:00:00.000Z", value: 30 },
    { periodStart: "2026-07-15T00:00:00.000Z", value: 40 },
    { periodStart: "2026-07-16T00:00:00.000Z", value: 50 },
  ],
  spineTotal: 12_045,
  health: "green",
  liveness: {
    status: "up",
    lastEventAt: "2026-07-16T10:00:00.000Z",
    lastHeartbeatAt: "2026-07-16T09:55:00.000Z",
    lastEventAgeMinutes: 5,
    freshestAgeMinutes: 5,
  },
  counts: { today: 12, last7d: 210, prev7d: 180, last30d: 842, prev30d: 700 },
  heatmap: [
    { weekday: 2, hour: 14, value: 40 },
    { weekday: 3, hour: 9, value: 25 },
    { weekday: 1, hour: 10, value: 15 },
  ],
  mix: [
    { label: "money", color: "#2e9e5b", value: 300 },
    { label: "leads", color: "#3457d5", value: 200 },
    { label: "agents", color: "#7c8db0", value: 100 },
  ],
  typeMix: [{ type: "payment.captured", count: 300 }],
};

function render(): string {
  return renderToStaticMarkup(createElement(PulseBody, { data: DATA, range: "30d" }));
}

describe("PulseBody (numbers-first)", () => {
  it("renders the headline stat tiles by default", () => {
    const html = render();
    expect(html).toContain("Today");
    expect(html).toContain("12"); // today's count
    expect(html).toContain("Last 7 days");
    expect(html).toContain("Last 30 days");
    expect(html).toContain("Active days");
  });

  it("renders the top-category and busiest-slot headline numbers", () => {
    const html = render();
    expect(html).toContain("Top category");
    expect(html).toContain("money");
    expect(html).toContain("Busiest slot");
    expect(html).toContain("Tue 14:00");
  });

  it("shows no chart/donut/heatmap body until expanded (all collapsed by default)", () => {
    const html = render();
    // The ExpandableChart body (LineChart / Donut / Heatmap) never mounts
    // until opened — only the tiny ≤48px axis-less sparkline hints (allowed
    // by §Numbers first) may appear, and those carry no viewBox/gridlines.
    expect(html).not.toContain("data-expandable-chart-body");
    expect(html).not.toContain('viewBox="0 0 640 220"'); // LineChart's fixed viewBox
    expect(html).not.toContain('aria-label="category mix"'); // Donut
  });

  it("offers a Show control for every collapsed chart group", () => {
    const html = render();
    expect(html).toContain("Show daily chart");
    expect(html).toContain("Show mix ring");
    expect(html).toContain("Show hour × weekday grid");
  });
});
