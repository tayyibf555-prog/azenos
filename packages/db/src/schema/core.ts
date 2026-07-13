import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clientStatus } from "./enums";

// §4.1 Core tables. Multi-tenant from day 1: everything hangs off organizations.
// Deviation from spec §4 (recorded in docs/DECISIONS.md): org_id is denormalized
// onto EVERY table so the RLS policy is uniform and analytics never need joins.

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable("users", {
  // Mirrors the Supabase auth uid — no cross-schema FK for portability
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phoneWhatsapp: text("phone_whatsapp"),
  role: text("role").notNull().default("owner"),
  notificationPrefs: jsonb("notification_prefs")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const industries = pgTable("industries", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
});

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    company: text("company"),
    industryId: uuid("industry_id").references(() => industries.id),
    status: clientStatus("status").notNull().default("lead"),
    source: text("source"),
    emails: text("emails").array().notNull().default([]),
    phones: text("phones").array().notNull().default([]),
    website: text("website"),
    notes: text("notes"),
    ltvCachePence: bigint("ltv_cache_pence", { mode: "number" }),
    // Phase 4 invoicing (owner requirement): markup % applied to attributed
    // API cost on this client's monthly cost statement. Null = org default
    // (DEFAULT_COST_MARKUP_PCT). 0 = pass-through at cost.
    costMarkupPct: integer("cost_markup_pct"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("clients_org_idx").on(t.orgId, t.status)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role"),
    email: text("email"),
    phone: text("phone"),
  },
  (t) => [index("contacts_client_idx").on(t.clientId)],
);
