import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { upsellProposals } from "./agents";
import { clients, organizations } from "./core";
import { shareKind } from "./enums";
import { projects } from "./projects";

// Phase 8 §P8-REPORT (docs/phase8/CONTRACTS.md) — share_tokens: public,
// unguessable links to white-label client artifacts (monthly reports, sent
// proposals). The token IS the capability: >=32 random bytes url-safe, no
// login, resolvable only while neither revoked nor expired. View stats power
// the "viewed Nx" chips on the Growth board and report share affordances.
export const shareTokens = pgTable(
  "share_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "cascade",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    proposalId: uuid("proposal_id").references(() => upsellProposals.id, {
      onDelete: "cascade",
    }),
    kind: shareKind("kind").notNull(),
    // At-rest protection (Phase-8 adversarial finding, lead ruling): the raw
    // bearer token is NEVER stored. Lookup = sha256 hex of the token; the
    // AES-256-GCM ciphertext (INGEST_SECRET_ENC_KEY, @azen/db/keys) exists
    // ONLY to re-display the link to the owner. A read-only DB leak yields
    // nothing usable.
    tokenHash: text("token_hash").notNull().unique(),
    tokenCiphertext: text("token_ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  },
  (t) => [index("share_tokens_org_kind_idx").on(t.orgId, t.kind, t.createdAt)],
);
