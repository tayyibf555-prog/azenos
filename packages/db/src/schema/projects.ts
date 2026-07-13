import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clients, organizations } from "./core";
import {
  integrationProvider,
  keyAuthMode,
  projectHealth,
  projectStack,
  projectStatus,
  projectType,
} from "./enums";

// §4.2 Projects & integrations

export interface ProjectGoal {
  metric: string;
  target: number;
  period: "day" | "week" | "month";
}

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    type: projectType("type").notNull(),
    stack: projectStack("stack").notNull().default("custom_code"),
    status: projectStatus("status").notNull().default("scoping"),
    buildFeePence: bigint("build_fee_pence", { mode: "number" })
      .notNull()
      .default(0),
    retainerPenceMonthly: bigint("retainer_pence_monthly", { mode: "number" })
      .notNull()
      .default(0),
    retainerActive: boolean("retainer_active").notNull().default(false),
    startDate: date("start_date"),
    liveDate: date("live_date"),
    health: projectHealth("health").notNull().default("green"),
    goals: jsonb("goals").$type<ProjectGoal[]>().notNull().default([]),
    // §8.1/§10 time-value rate; null = config DEFAULT_HOURLY_RATE_PENCE (£30/h)
    hourlyRatePence: integer("hourly_rate_pence"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("projects_org_status_idx").on(t.orgId, t.status)],
);

export const projectKeys = pgTable(
  "project_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Stable URL identity (§6.1): rotation replaces the secret, never this
    publicKey: text("public_key").notNull().unique(),
    // sha256 hex of the azn_sk_ secret — token-mode compare + display
    secretHash: text("secret_hash").notNull(),
    // AES-256-GCM under INGEST_SECRET_ENC_KEY — HMAC verification needs the
    // recoverable secret (§6.2); see @azen/db/keys and docs/DECISIONS.md
    secretCiphertext: text("secret_ciphertext").notNull().default(""),
    authMode: keyAuthMode("auth_mode").notNull().default("hmac"),
    // §6.3 step 2 — default 100 req/10s, configurable per project
    rateLimitPer10s: integer("rate_limit_per_10s").notNull().default(100),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("project_keys_project_idx").on(t.projectId)],
);

export const projectIntegrations = pgTable(
  "project_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: integrationProvider("provider").notNull(),
    externalId: text("external_id"),
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("project_integrations_provider_idx").on(t.provider, t.externalId),
  ],
);
