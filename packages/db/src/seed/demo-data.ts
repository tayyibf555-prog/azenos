/**
 * Demo dataset definitions — 1 org, 3 clients (dental, trades, clinic),
 * 4 projects (spec §13). IDs and webhook secrets are FIXED so the seed is
 * deterministic and the simulate CLI can sign requests without a lookup.
 * These demo secrets are for local/demo use only — real keys are generated
 * randomly at project creation (Phase 1).
 */

export const ORG_ID = "aaaaaaaa-0000-4000-8000-000000000001";
export const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000002";

export const OWNER = {
  id: OWNER_ID,
  name: "Tayyib",
  email: "tayyibf555@gmail.com",
  role: "owner" as const,
};

export const INDUSTRIES = [
  { id: "bbbbbbbb-0000-4000-8000-000000000001", slug: "dental", name: "Dental" },
  { id: "bbbbbbbb-0000-4000-8000-000000000002", slug: "trades", name: "Trades" },
  { id: "bbbbbbbb-0000-4000-8000-000000000003", slug: "clinics", name: "Clinics" },
] as const;

export const CLIENTS = [
  {
    id: "cccccccc-0000-4000-8000-000000000001",
    name: "Sarah Mitchell",
    company: "Smile Dental Studio",
    industrySlug: "dental",
    status: "active" as const,
    source: "referral",
    emails: ["sarah@smiledental.example"],
    phones: ["+447700900101"],
    website: "https://smiledental.example",
    contacts: [
      { name: "Sarah Mitchell", role: "Practice Owner", email: "sarah@smiledental.example" },
      { name: "Priya Shah", role: "Practice Manager", email: "priya@smiledental.example" },
    ],
  },
  {
    id: "cccccccc-0000-4000-8000-000000000002",
    name: "Dave Ogden",
    company: "Elite Trades Group",
    industrySlug: "trades",
    status: "active" as const,
    source: "linkedin",
    emails: ["dave@elitetrades.example"],
    phones: ["+447700900102"],
    website: "https://elitetrades.example",
    contacts: [{ name: "Dave Ogden", role: "Director", email: "dave@elitetrades.example" }],
  },
  {
    id: "cccccccc-0000-4000-8000-000000000003",
    name: "Dr. Amara Okafor",
    company: "BrightClinic Physio",
    industrySlug: "clinics",
    status: "active" as const,
    source: "discovery_call",
    emails: ["amara@brightclinic.example"],
    phones: ["+447700900103"],
    website: "https://brightclinic.example",
    contacts: [{ name: "Dr. Amara Okafor", role: "Clinical Director", email: "amara@brightclinic.example" }],
  },
] as const;

export interface DemoProject {
  id: string;
  clientId: string;
  name: string;
  slug: string;
  description: string;
  type: "ai_agent" | "automation" | "chatbot" | "voice_agent";
  stack: "custom_code" | "ghl";
  buildFeePence: number;
  retainerPenceMonthly: number;
  /** days before "today" the project went live (all demo projects are live) */
  liveDaysAgo: number;
  publicKey: string;
  demoSecret: string;
  goals: { metric: string; target: number; period: "month" }[];
}

export const PROJECTS: DemoProject[] = [
  {
    id: "dddddddd-0000-4000-8000-000000000001",
    clientId: CLIENTS[0].id,
    name: "AI Receptionist",
    slug: "smile-dental-receptionist",
    description:
      "Voice AI receptionist answering calls, booking patients, and handling FAQs out of hours.",
    type: "voice_agent",
    stack: "custom_code",
    buildFeePence: 450_000,
    retainerPenceMonthly: 120_000,
    liveDaysAgo: 120,
    publicKey: "azn_pk_demo_smile_receptionist",
    demoSecret: "azn_sk_demo_smile_receptionist_2f8a1c9d",
    goals: [{ metric: "bookings_created", target: 180, period: "month" }],
  },
  {
    id: "dddddddd-0000-4000-8000-000000000002",
    clientId: CLIENTS[0].id,
    name: "Recall Reminders",
    slug: "smile-dental-recall",
    description:
      "Automated recall campaign: daily batch SMS to lapsed patients with self-serve rebooking.",
    type: "automation",
    stack: "custom_code",
    buildFeePence: 180_000,
    retainerPenceMonthly: 40_000,
    liveDaysAgo: 75,
    publicKey: "azn_pk_demo_smile_recall",
    demoSecret: "azn_sk_demo_smile_recall_7be40d11",
    goals: [{ metric: "bookings_created", target: 60, period: "month" }],
  },
  {
    id: "dddddddd-0000-4000-8000-000000000003",
    clientId: CLIENTS[1].id,
    name: "Quote Bot",
    slug: "elite-trades-quotebot",
    description:
      "GHL webchat bot qualifying leads and generating instant quotes for trade jobs.",
    type: "chatbot",
    stack: "ghl",
    buildFeePence: 320_000,
    retainerPenceMonthly: 90_000,
    liveDaysAgo: 95,
    publicKey: "azn_pk_demo_elite_quotebot",
    demoSecret: "azn_sk_demo_elite_quotebot_c31d99e2",
    goals: [{ metric: "quotes_sent", target: 90, period: "month" }],
  },
  {
    id: "dddddddd-0000-4000-8000-000000000004",
    clientId: CLIENTS[2].id,
    name: "Webchat Assistant",
    slug: "brightclinic-webchat",
    description:
      "Webchat assistant booking physio sessions and triaging patient questions.",
    type: "ai_agent",
    stack: "custom_code",
    buildFeePence: 280_000,
    retainerPenceMonthly: 75_000,
    liveDaysAgo: 60,
    publicKey: "azn_pk_demo_brightclinic_webchat",
    demoSecret: "azn_sk_demo_brightclinic_webchat_90aa41f7",
    goals: [{ metric: "bookings_created", target: 120, period: "month" }],
  },
];

/** §8.1 default KPI pack — seeded as org-level defaults (project_id null) */
export const DEFAULT_METRIC_DEFINITIONS = [
  { key: "conversations", name: "Conversations", eventType: "llm.conversation", aggregation: "count", unit: "count", isKpi: true, goodDirection: "up", sort: 10 },
  { key: "bookings_created", name: "Bookings created", eventType: "booking.created", aggregation: "count", unit: "count", isKpi: true, goodDirection: "up", sort: 20 },
  { key: "leads_created", name: "Leads created", eventType: "lead.created", aggregation: "count", unit: "count", isKpi: false, goodDirection: "up", sort: 30 },
  { key: "quotes_sent", name: "Quotes sent", eventType: "quote.sent", aggregation: "count", unit: "count", isKpi: false, goodDirection: "up", sort: 40 },
  { key: "revenue_attributed", name: "Revenue attributed", eventType: "*", aggregation: "sum", unit: "pence", valuePath: "$.value_pence", isKpi: true, goodDirection: "up", sort: 50 },
  { key: "minutes_saved", name: "Minutes saved", eventType: "*", aggregation: "sum", unit: "minutes", valuePath: "$.minutes_saved", isKpi: true, goodDirection: "up", sort: 60 },
  { key: "agent_runs", name: "Agent runs", eventType: "agent.run.completed", aggregation: "count", unit: "count", isKpi: false, goodDirection: "up", sort: 70 },
  { key: "escalations", name: "Escalations to human", eventType: "agent.escalated_to_human", aggregation: "count", unit: "count", isKpi: false, goodDirection: "down", sort: 80 },
  { key: "errors", name: "System errors", eventType: "system.error", aggregation: "count", unit: "count", isKpi: true, goodDirection: "down", sort: 90 },
  // Phase 2 (M1) additions to the §8.1 pack. NOTE: seed/index.ts's insert map
  // does not carry whereEquals, so the demo agent_runs_succeeded row lands with
  // a null filter (behaves like agent_runs) until that map is extended.
  { key: "events_total", name: "Events total", eventType: "*", aggregation: "count", unit: "count", isKpi: false, goodDirection: "up", sort: 5 },
  { key: "calls_handled", name: "Calls handled", eventType: "call.completed", aggregation: "count", unit: "count", isKpi: false, goodDirection: "up", sort: 45 },
  { key: "forms_submitted", name: "Forms submitted", eventType: "form.submitted", aggregation: "count", unit: "count", isKpi: false, goodDirection: "up", sort: 46 },
  { key: "payments_captured", name: "Payments captured", eventType: "payment.captured", aggregation: "count", unit: "count", isKpi: false, goodDirection: "up", sort: 51 },
  { key: "avg_transaction_pence", name: "Avg transaction value", eventType: "payment.captured", aggregation: "avg", unit: "pence", valuePath: "$.data.amount_pence", isKpi: false, goodDirection: "up", sort: 52 },
  { key: "agent_runs_succeeded", name: "Agent runs succeeded", eventType: "agent.run.completed", aggregation: "count", unit: "count", whereEquals: { "$.data.success": true }, isKpi: false, goodDirection: "up", sort: 71 },
  { key: "tokens_cost_pence", name: "Tokens cost", eventType: "agent.run.completed", aggregation: "sum", unit: "pence", valuePath: "$.data.cost_pence", isKpi: false, goodDirection: "down", sort: 75 },
  { key: "reviews_avg_rating", name: "Avg review rating", eventType: "review.received", aggregation: "avg", unit: "count", valuePath: "$.data.rating", isKpi: false, goodDirection: "up", sort: 85 },
] as const;

/** Org-wide default alert rules (§4.8) */
export const DEFAULT_ALERT_RULES = [
  {
    kind: "error_streak" as const,
    condition: { event_type: "system.error", count: 3, window_minutes: 30 },
    channel: "whatsapp" as const,
    cooldownMinutes: 120,
  },
  {
    kind: "event_silence" as const,
    condition: { hours_since_last_event: 24 },
    channel: "whatsapp" as const,
    cooldownMinutes: 720,
  },
  {
    kind: "payment_overdue" as const,
    condition: { days_overdue: 5 },
    channel: "email" as const,
    cooldownMinutes: 1440,
  },
];
