import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { briefs, clients, db, organizations, shareTokens, upsellProposals } from "@azen/db";
import { decryptSecret, encryptSecret, sha256Hex } from "@azen/db/keys";

/**
 * Phase 8 §P8-REPORT (docs/phase8/CONTRACTS.md) — share_tokens core.
 *
 * A share token IS the capability: an unguessable, url-safe string that grants
 * READ-ONLY, logged-out access to exactly one white-label artifact (a client's
 * latest monthly value report, or a sent proposal). No org internals ever leave
 * this module: resolveShareToken returns only the ids the public renderer needs
 * to fetch its ONE artifact, and the load* helpers return pre-shaped,
 * white-label-safe view models (never org ids, keys, cost internals, or other
 * clients' data).
 *
 * At-rest protection (lead ruling, resolving the Phase-8 W1 escalation — the
 * ingest-key pattern from @azen/db/keys):
 *  - The RAW bearer token is NEVER stored. The row keeps only
 *      token_hash        sha256(token) — the lookup key (unique);
 *      token_ciphertext  AES-256-GCM(token) under INGEST_SECRET_ENC_KEY,
 *                        decrypted ONLY to re-display the link to the owner.
 *  - createShareToken generates the token, persists (hash, ciphertext), and
 *    returns the raw token EXACTLY ONCE (from the mint call). No read API ever
 *    returns it again.
 *  - resolveShareToken(token) looks it up by sha256(token) = token_hash. The
 *    match is on the digest, so a guessed token never leaks the real one; the
 *    hash lookup needs no encryption key, so the PUBLIC path never depends on
 *    INGEST_SECRET_ENC_KEY.
 *  - revealShareLink(orgId, tokenId) decrypts token_ciphertext for the
 *    AUTHENTICATED owner's "copy link again" — org-scoped, never on any public
 *    path. Missing INGEST_SECRET_ENC_KEY → enc_key_missing (routes → 503) on
 *    mint / reveal only; resolve keeps working.
 *
 * Other invariants:
 *  - Tokens are crypto.randomBytes(32) → base64url (43 chars, ≥256 bits).
 *  - resolveShareToken returns null for unknown / revoked / expired tokens —
 *    the public route maps null to a clean branded 404 with NO info leak.
 *  - createShareToken/revokeShareToken are org-scoped: a token can only be
 *    minted for (or revoked against) a client/proposal owned by the caller's
 *    org — cross-org references are refused.
 */

export type ShareKind = "monthly_report" | "proposal";

export interface CreateShareInput {
  kind: ShareKind;
  clientId?: string | null;
  projectId?: string | null;
  proposalId?: string | null;
  /** ISO timestamp; null / omitted = never expires. */
  expiresAt?: string | null;
}

/**
 * The metadata a read API may return about a token. It deliberately carries NO
 * token material (neither the raw token nor its hash/ciphertext) — the raw
 * token escapes ONLY from the mint call (CreateShareResult.token) and the
 * owner-only reveal (revealShareLink).
 */
export interface ShareTokenRecord {
  id: string;
  kind: ShareKind;
  clientId: string | null;
  projectId: string | null;
  proposalId: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

export type CreateShareResult =
  | { ok: true; record: ShareTokenRecord; token: string }
  | { ok: false; error: "invalid_input" | "not_found" | "enc_key_missing" };

/** Owner-only re-display of an existing token's raw link (decrypts ciphertext). */
export type RevealShareResult =
  | { ok: true; token: string }
  | { ok: false; error: "not_found" | "enc_key_missing" };

/** The minimal, org-safe descriptor the public renderer resolves a token to. */
export interface ResolvedShare {
  id: string;
  /** server-side only — used to scope the artifact fetch, NEVER rendered. */
  orgId: string;
  kind: ShareKind;
  clientId: string | null;
  projectId: string | null;
  proposalId: string | null;
}

/** Generate a url-safe, unguessable token (43 base64url chars from 32 bytes). */
export function generateShareTokenString(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * True when INGEST_SECRET_ENC_KEY is present and a valid 32-byte base64 key —
 * i.e. the AES-256-GCM encrypt/decrypt used for the token ciphertext can run.
 * Mint and reveal require it; resolve (hash-only) does not.
 */
function encKeyAvailable(): boolean {
  const raw = process.env.INGEST_SECRET_ENC_KEY;
  if (!raw) return false;
  try {
    return Buffer.from(raw, "base64").length === 32;
  } catch {
    return false;
  }
}

function toRecord(row: typeof shareTokens.$inferSelect): ShareTokenRecord {
  return {
    id: row.id,
    kind: row.kind as ShareKind,
    clientId: row.clientId,
    projectId: row.projectId,
    proposalId: row.proposalId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    viewCount: row.viewCount,
    lastViewedAt: row.lastViewedAt ? row.lastViewedAt.toISOString() : null,
  };
}

/**
 * Mint a share token for a client's monthly report or a sent proposal. The
 * referenced client / proposal MUST belong to `orgId` (cross-org refused).
 */
export async function createShareToken(
  orgId: string,
  input: CreateShareInput,
): Promise<CreateShareResult> {
  // The secondary ids persisted on the row are NEVER taken from caller input:
  // they are derived from the ONE org-owned entity this kind validates against,
  // so a token can never be minted holding another org's client/project/proposal
  // (the FKs are single-column existence checks — org-scoping must happen here).
  let storedClientId: string | null = null;
  let storedProjectId: string | null = null;
  let storedProposalId: string | null = null;

  if (input.kind === "monthly_report") {
    if (!input.clientId) return { ok: false, error: "invalid_input" };
    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, input.clientId), eq(clients.orgId, orgId)),
      columns: { id: true },
    });
    if (!client) return { ok: false, error: "not_found" };
    storedClientId = client.id;
  } else if (input.kind === "proposal") {
    if (!input.proposalId) return { ok: false, error: "invalid_input" };
    const proposal = await db.query.upsellProposals.findFirst({
      where: and(
        eq(upsellProposals.id, input.proposalId),
        eq(upsellProposals.orgId, orgId),
      ),
      columns: { id: true, clientId: true, projectId: true },
    });
    if (!proposal) return { ok: false, error: "not_found" };
    // clientId / projectId come from the org-owned proposal row itself, so the
    // public proposal renderer (P8-GROWTH2) resolves only org-owned references.
    storedProposalId = proposal.id;
    storedClientId = proposal.clientId ?? null;
    storedProjectId = proposal.projectId ?? null;
  } else {
    return { ok: false, error: "invalid_input" };
  }

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
    return { ok: false, error: "invalid_input" };
  }

  // Minting persists the token ciphertext, so it needs the AES key. Fail with a
  // typed error (route → 503) BEFORE inserting, rather than writing a row whose
  // link could never be re-displayed.
  if (!encKeyAvailable()) return { ok: false, error: "enc_key_missing" };

  // The raw token is the capability. We store only its sha256 (the lookup key)
  // and its AES-256-GCM ciphertext (owner re-display) — never the token itself —
  // and hand the caller the raw string this one time.
  const token = generateShareTokenString();
  const [row] = await db
    .insert(shareTokens)
    .values({
      orgId,
      kind: input.kind,
      clientId: storedClientId,
      projectId: storedProjectId,
      proposalId: storedProposalId,
      tokenHash: sha256Hex(token),
      tokenCiphertext: encryptSecret(token),
      expiresAt,
    })
    .returning();

  return { ok: true, record: toRecord(row!), token };
}

/**
 * Owner-only "copy link again": decrypt an existing token's ciphertext back to
 * the raw token so the authenticated owner can re-copy the share link. Org-scoped
 * (a cross-org / unknown id resolves to not_found), and NEVER reachable from any
 * public path. Missing INGEST_SECRET_ENC_KEY → enc_key_missing (route → 503).
 */
export async function revealShareLink(
  orgId: string,
  tokenId: string,
): Promise<RevealShareResult> {
  if (!encKeyAvailable()) return { ok: false, error: "enc_key_missing" };
  const row = await db.query.shareTokens.findFirst({
    where: and(eq(shareTokens.id, tokenId), eq(shareTokens.orgId, orgId)),
    columns: { tokenCiphertext: true },
  });
  if (!row) return { ok: false, error: "not_found" };
  return { ok: true, token: decryptSecret(row.tokenCiphertext) };
}

/** Revoke a token (org-scoped). Idempotent: revoking an already-revoked token is a no-op success. */
export async function revokeShareToken(
  orgId: string,
  tokenId: string,
): Promise<boolean> {
  const [row] = await db
    .update(shareTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(shareTokens.id, tokenId),
        eq(shareTokens.orgId, orgId),
        isNull(shareTokens.revokedAt),
      ),
    )
    .returning({ id: shareTokens.id });
  if (row) return true;
  // Distinguish "already revoked but yours" (still success) from "not yours".
  const existing = await db.query.shareTokens.findFirst({
    where: and(eq(shareTokens.id, tokenId), eq(shareTokens.orgId, orgId)),
    columns: { id: true },
  });
  return existing != null;
}

/**
 * Resolve a raw token string to its org-safe descriptor, or null when the token
 * is unknown, revoked, or expired. Does NOT record a view (call recordView).
 */
export async function resolveShareToken(
  token: string,
): Promise<ResolvedShare | null> {
  if (!token) return null;
  // Look up by the digest, not the raw token: the stored column is the sha256,
  // so a guessed token is hashed and matched against an indexed unique hash —
  // no plaintext token ever sits in the row to compare against or to leak. This
  // path needs no encryption key, so the public renderer never depends on it.
  const row = await db.query.shareTokens.findFirst({
    where: eq(shareTokens.tokenHash, sha256Hex(token)),
  });
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return {
    id: row.id,
    orgId: row.orgId,
    kind: row.kind as ShareKind,
    clientId: row.clientId,
    projectId: row.projectId,
    proposalId: row.proposalId,
  };
}

/** Record a single view: view_count += 1, last_viewed_at = now. */
export async function recordView(tokenId: string): Promise<void> {
  await db
    .update(shareTokens)
    .set({
      viewCount: sql`${shareTokens.viewCount} + 1`,
      lastViewedAt: sql`now()`,
    })
    .where(eq(shareTokens.id, tokenId));
}

/** All tokens minted for a client's monthly report (newest first), org-scoped. */
export async function listMonthlyReportTokens(
  orgId: string,
  clientId: string,
): Promise<ShareTokenRecord[]> {
  const rows = await db.query.shareTokens.findMany({
    where: and(
      eq(shareTokens.orgId, orgId),
      eq(shareTokens.clientId, clientId),
      eq(shareTokens.kind, "monthly_report"),
    ),
    orderBy: [desc(shareTokens.createdAt)],
  });
  return rows.map(toRecord);
}

// ── public artifact view models (white-label-safe; NO org internals) ──────────

/** Headline value numbers reused from the monthly datapack / ROI conventions. */
export interface SharedReportHeadline {
  revenueTouchedPence: number;
  hoursSaved: number;
  roiMultiple: number | null;
  bookingsMade: number;
  conversationsHandled: number;
  resolvedRate: number | null;
}

export interface SharedMonthlyReport {
  agencyName: string;
  clientName: string;
  monthLabel: string;
  headline: string;
  bodyMd: string;
  value: SharedReportHeadline;
  generatedAt: string;
}

interface ClientReportSnapshot {
  clientName?: unknown;
  forMonth?: unknown;
  client?: {
    clientName?: unknown;
    revenueTouchedPence?: unknown;
    hoursSaved?: unknown;
    roiMultiple?: unknown;
    bookingsMade?: unknown;
    conversationsHandled?: unknown;
    resolvedRate?: unknown;
  } | null;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Human "July 2026" from a 'YYYY-MM' string; falls back to the raw value. */
function monthLabelFromForMonth(forMonth: unknown): string {
  if (typeof forMonth !== "string" || !/^\d{4}-\d{2}$/.test(forMonth)) {
    return typeof forMonth === "string" ? forMonth : "";
  }
  const [y, m] = forMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y!, (m ?? 1) - 1, 1));
  return d.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Load the latest monthly client value report for a resolved monthly_report
 * token. Returns null when the client has no such report yet (public route
 * degrades to a branded "not ready" 404). White-label-safe: only the agency
 * name, client name, month, headline, rendered body markdown and the headline
 * value numbers escape — no org ids, no cost internals, no other clients.
 */
export async function loadSharedMonthlyReport(
  resolved: ResolvedShare,
): Promise<SharedMonthlyReport | null> {
  if (resolved.kind !== "monthly_report" || !resolved.clientId) return null;

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, resolved.orgId),
    columns: { name: true },
  });

  const [row] = await db
    .select({
      headline: briefs.headline,
      bodyMd: briefs.bodyMd,
      dataSnapshot: briefs.dataSnapshot,
      periodStart: briefs.periodStart,
      createdAt: briefs.createdAt,
    })
    .from(briefs)
    .where(
      and(
        eq(briefs.orgId, resolved.orgId),
        eq(briefs.period, "monthly"),
        sql`${briefs.dataSnapshot}->>'docType' = 'client_value_report'`,
        sql`${briefs.dataSnapshot}->>'clientId' = ${resolved.clientId}`,
      ),
    )
    .orderBy(desc(briefs.periodStart), desc(briefs.createdAt))
    .limit(1);

  if (!row) return null;

  const snapshot = (row.dataSnapshot ?? {}) as ClientReportSnapshot;
  const client = snapshot.client ?? {};
  const clientName =
    (typeof snapshot.clientName === "string" && snapshot.clientName) ||
    (typeof client.clientName === "string" && client.clientName) ||
    "Client";

  return {
    agencyName: org?.name ?? "Your Agency",
    clientName,
    monthLabel: monthLabelFromForMonth(snapshot.forMonth),
    headline: row.headline,
    bodyMd: row.bodyMd,
    value: {
      revenueTouchedPence: numOr(client.revenueTouchedPence, 0),
      hoursSaved: numOr(client.hoursSaved, 0),
      roiMultiple: numOrNull(client.roiMultiple),
      bookingsMade: numOr(client.bookingsMade, 0),
      conversationsHandled: numOr(client.conversationsHandled, 0),
      resolvedRate: numOrNull(client.resolvedRate),
    },
    generatedAt: row.createdAt.toISOString(),
  };
}
