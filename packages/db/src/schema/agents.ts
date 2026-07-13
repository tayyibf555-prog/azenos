import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { EMBEDDING_DIMS } from "@azen/config";
import { clients, industries, organizations, users } from "./core";
import {
  agentRunStatus,
  briefPeriod,
  briefScope,
  briefStatus,
  chatRole,
  createdByKind,
  insightConfidence,
  insightKind,
  insightStatus,
  knowledgeKind,
  osAgentKind,
  proposalStatus,
} from "./enums";
import { projects } from "./projects";

// §4.7 Agent output tables. Agents never write raw data — only these.

export const briefs = pgTable(
  "briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    scope: briefScope("scope").notNull(),
    projectId: uuid("project_id").references(() => projects.id),
    period: briefPeriod("period").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    headline: text("headline").notNull(),
    bodyMd: text("body_md").notNull(),
    // ≤~900 chars, punchy; template variables must stay single-line (§9.7)
    bodyWhatsapp: text("body_whatsapp"),
    // exact numbers the agent saw — auditability
    dataSnapshot: jsonb("data_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    status: briefStatus("status").notNull().default("generated"),
    sentEmailAt: timestamp("sent_email_at", { withTimezone: true }),
    sentWhatsappAt: timestamp("sent_whatsapp_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("briefs_org_period_idx").on(t.orgId, t.period, t.periodStart.desc())],
);

export const insights = pgTable(
  "insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    kind: insightKind("kind").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    // event ids + aggregates that prove it
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // dedup key for the Scout (§9.4): project + fingerprint
    fingerprint: text("fingerprint"),
    estimatedValuePence: bigint("estimated_value_pence", { mode: "number" }),
    estimatedHoursSavedMonthly: integer("estimated_hours_saved_monthly"),
    confidence: insightConfidence("confidence").notNull().default("med"),
    status: insightStatus("status").notNull().default("new"),
    createdBy: createdByKind("created_by").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("insights_project_status_idx").on(t.projectId, t.status),
    index("insights_fingerprint_idx").on(t.projectId, t.fingerprint),
  ],
);

export const upsellProposals = pgTable(
  "upsell_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    projectId: uuid("project_id").references(() => projects.id),
    title: text("title").notNull(),
    problemMd: text("problem_md").notNull(),
    proposalMd: text("proposal_md").notNull(),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    suggestedPricePence: bigint("suggested_price_pence", { mode: "number" }),
    status: proposalStatus("status").notNull().default("draft"),
    insightIds: uuid("insight_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("upsells_client_status_idx").on(t.clientId, t.status)],
);

export const knowledgeArticles = pgTable(
  "knowledge_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    industryId: uuid("industry_id")
      .notNull()
      .references(() => industries.id),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    // event stats + web citations
    sources: jsonb("sources")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    kind: knowledgeKind("kind").notNull(),
    // Voyage AI embeddings (§12) — populated in Phase 6
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMS }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("knowledge_industry_idx").on(t.industryId, t.kind)],
);

/**
 * The OS eats its own dog food: its OWN agents' cost and ROI are tracked
 * here and surfaced on the Money screen (§10).
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    agent: osAgentKind("agent").notNull(),
    // Cost attribution for client billing (owner requirement, Phase 2):
    // every OS-side AI run should be pinned to the client/project it served.
    // Null = org-level overhead (e.g. intake before the project exists —
    // backfilled by /api/projects/intake/attribute once created).
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: agentRunStatus("status").notNull().default("running"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costEstimatePence: integer("cost_estimate_pence"),
    error: text("error"),
    outputRefs: jsonb("output_refs")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => [
    index("agent_runs_org_idx").on(t.orgId, t.startedAt.desc()),
    index("agent_runs_project_idx").on(t.projectId, t.startedAt.desc()),
  ],
);

// §4.7 + §9.8 Ask Azen chat persistence

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title"),
    // page context at start, e.g. {project_id}
    context: jsonb("context")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("chat_sessions_org_idx").on(t.orgId, t.createdAt.desc())],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: chatRole("role").notNull(),
    contentMd: text("content_md").notNull(),
    // full trace — chat's data_snapshot, rendered as "how I got this"
    toolCalls: jsonb("tool_calls").$type<unknown[]>().notNull().default([]),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costEstimatePence: integer("cost_estimate_pence"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("chat_messages_session_idx").on(t.sessionId, t.createdAt)],
);
