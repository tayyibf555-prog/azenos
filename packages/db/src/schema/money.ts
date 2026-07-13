import {
  bigint,
  boolean,
  char,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clients, organizations } from "./core";
import {
  expenseCategory,
  paymentKind,
  paymentSource,
  paymentStatus,
  subscriptionStatus,
} from "./enums";
import { projects } from "./projects";

/**
 * §4.5 Money — the AGENCY ledger (client paying Azen). Two-ledger rule (§10):
 * client end-customer payment.* events stay in `events`/rollups and NEVER
 * write here. This ledger is fed solely by the org-level Stripe hook and
 * manual bank-transfer entry/CSV import.
 */

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    projectId: uuid("project_id").references(() => projects.id),
    source: paymentSource("source").notNull(),
    kind: paymentKind("kind").notNull(),
    amountPence: bigint("amount_pence", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("gbp"),
    status: paymentStatus("status").notNull().default("paid"),
    externalId: text("external_id"),
    invoiceRef: text("invoice_ref"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("payments_org_paid_idx").on(t.orgId, t.paidAt.desc()),
    index("payments_client_idx").on(t.clientId),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    projectId: uuid("project_id").references(() => projects.id),
    // null for bank-transfer retainers — those get a monthly 'expected
    // payment' check that flags late payers (§4.5)
    stripeSubscriptionId: text("stripe_subscription_id"),
    amountPenceMonthly: bigint("amount_pence_monthly", {
      mode: "number",
    }).notNull(),
    status: subscriptionStatus("status").notNull().default("active"),
    startedAt: date("started_at").notNull(),
    cancelledAt: date("cancelled_at"),
  },
  (t) => [index("subscriptions_org_idx").on(t.orgId, t.status)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id").references(() => projects.id),
    category: expenseCategory("category").notNull(),
    vendor: text("vendor").notNull(),
    amountPence: bigint("amount_pence", { mode: "number" }).notNull(),
    recurring: boolean("recurring").notNull().default(false),
    // e.g. '2026-07' for a monthly recurring expense occurrence
    period: text("period"),
    notes: text("notes"),
    incurredAt: date("incurred_at").notNull(),
  },
  (t) => [index("expenses_org_idx").on(t.orgId, t.incurredAt.desc())],
);
