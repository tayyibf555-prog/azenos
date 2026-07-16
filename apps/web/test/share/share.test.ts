import { createHash, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { clients, db, organizations, shareTokens } from "@azen/db";
import { eq } from "drizzle-orm";
import { MonthlyReportDoc } from "../../app/share/[token]/MonthlyReportDoc";
import {
  createShareToken,
  generateShareTokenString,
  loadSharedMonthlyReport,
  recordView,
  resolveShareToken,
  revealShareLink,
  revokeShareToken,
} from "../../lib/server/share";
import {
  type ShareHarness,
  cleanupShareHarness,
  createShareHarness,
} from "./helpers";

/**
 * §P8-REPORT share-link acceptance. Every test runs under a fresh throwaway org
 * (DEMO_ORG_ID is never touched). Covers entropy, revoked/expired → null (the
 * public route's branded 404), cross-org create refusal, single-view counting,
 * the rendered HTML never leaking org ids or the raw token, and — per the
 * at-rest ruling — that the persisted row holds NEITHER the raw token nor any
 * substring of it, resolve works via the hash, and the owner-only reveal path
 * decrypts the ciphertext back to the ORIGINAL link.
 */

/**
 * Deep-scan every value in a row and assert none contains the raw token or any
 * contiguous 8-char substring of it. 8 chars of the base64url token appearing
 * by chance inside the sha256 hex (no `-`/`_`, hex only) or the AES ciphertext
 * (random) is astronomically unlikely, so a hit means real leakage.
 */
function assertNoTokenLeak(row: unknown, token: string): void {
  const haystack = JSON.stringify(row);
  expect(haystack).not.toContain(token);
  for (let i = 0; i + 8 <= token.length; i++) {
    expect(haystack).not.toContain(token.slice(i, i + 8));
  }
}

describe("share tokens", () => {
  const harnesses: ShareHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const h = harnesses.pop();
      if (h) await cleanupShareHarness(h);
    }
  });

  async function harness(): Promise<ShareHarness> {
    const h = await createShareHarness();
    harnesses.push(h);
    return h;
  }

  it("generates url-safe, high-entropy tokens (>=43 base64url chars)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = generateShareTokenString();
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(t.length).toBeGreaterThanOrEqual(43);
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
  });

  it("creates then resolves a monthly_report token to its org-safe descriptor", async () => {
    const h = await harness();
    const created = await createShareToken(h.orgId, {
      kind: "monthly_report",
      clientId: h.clientId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const resolved = await resolveShareToken(created.token);
    expect(resolved).not.toBeNull();
    expect(resolved?.kind).toBe("monthly_report");
    expect(resolved?.clientId).toBe(h.clientId);
    expect(resolved?.orgId).toBe(h.orgId);
  });

  it("resolves a revoked token to null (branded 404)", async () => {
    const h = await harness();
    const created = await createShareToken(h.orgId, {
      kind: "monthly_report",
      clientId: h.clientId,
    });
    if (!created.ok) throw new Error("create failed");

    const ok = await revokeShareToken(h.orgId, created.record.id);
    expect(ok).toBe(true);
    expect(await resolveShareToken(created.token)).toBeNull();
  });

  it("resolves an expired token to null (branded 404)", async () => {
    const h = await harness();
    const created = await createShareToken(h.orgId, {
      kind: "monthly_report",
      clientId: h.clientId,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    if (!created.ok) throw new Error("create failed");
    expect(await resolveShareToken(created.token)).toBeNull();
  });

  it("refuses to create a token for a client in another org", async () => {
    const owner = await harness();
    const stranger = await harness();
    // Try to mint a link for the stranger's client under the owner's org.
    const result = await createShareToken(owner.orgId, {
      kind: "monthly_report",
      clientId: stranger.clientId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not_found");
  });

  it("refuses to revoke another org's token", async () => {
    const owner = await harness();
    const stranger = await harness();
    const created = await createShareToken(owner.orgId, {
      kind: "monthly_report",
      clientId: owner.clientId,
    });
    if (!created.ok) throw new Error("create failed");

    expect(await revokeShareToken(stranger.orgId, created.record.id)).toBe(false);
    // The owner's token still resolves — the stranger's revoke was a no-op.
    expect(await resolveShareToken(created.token)).not.toBeNull();
  });

  it("increments view_count by exactly one per recordView", async () => {
    const h = await harness();
    const created = await createShareToken(h.orgId, {
      kind: "monthly_report",
      clientId: h.clientId,
    });
    if (!created.ok) throw new Error("create failed");
    expect(created.record.viewCount).toBe(0);

    const resolved = await resolveShareToken(created.token);
    expect(resolved).not.toBeNull();
    await recordView(resolved!.id);
    await recordView(resolved!.id);

    // resolve does NOT bump the counter — only the two recordView calls did.
    const row = await db.query.shareTokens.findFirst({
      where: eq(shareTokens.id, created.record.id),
      columns: { viewCount: true },
    });
    expect(row?.viewCount).toBe(2);
  });

  it("loads a white-label report whose HTML leaks no org id or token", async () => {
    const h = await harness();
    const created = await createShareToken(h.orgId, {
      kind: "monthly_report",
      clientId: h.clientId,
    });
    if (!created.ok) throw new Error("create failed");

    const resolved = await resolveShareToken(created.token);
    const report = await loadSharedMonthlyReport(resolved!);
    expect(report).not.toBeNull();
    expect(report?.agencyName).toBe(h.orgName);
    expect(report?.clientName).toBe(h.clientName);

    const html = renderToStaticMarkup(MonthlyReportDoc({ report: report! }));
    // The white-label page shows the agency + client names, but NEVER internal
    // ids or the capability token.
    expect(html).not.toContain(h.orgId);
    expect(html).not.toContain(h.clientId);
    expect(html).not.toContain(h.briefId);
    expect(html).not.toContain(created.token);
    // It DOES surface the headline value numbers.
    expect(html).toContain(h.orgName);
    expect(html).toContain(h.clientName);
  });

  it("returns null for a monthly_report token whose client has no report", async () => {
    // Fresh org + client but NO brief seeded.
    const orgId = randomUUID();
    const clientId = randomUUID();
    await db.insert(organizations).values({ id: orgId, name: "Empty Org" });
    await db.insert(clients).values({
      id: clientId,
      orgId,
      name: "No Report Co",
      status: "active",
    });
    try {
      const created = await createShareToken(orgId, {
        kind: "monthly_report",
        clientId,
      });
      if (!created.ok) throw new Error("create failed");
      const resolved = await resolveShareToken(created.token);
      expect(await loadSharedMonthlyReport(resolved!)).toBeNull();
    } finally {
      await db.delete(clients).where(eq(clients.orgId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
  });

  // ── at-rest protection (lead ruling) ──────────────────────────────────────

  it("persists NEITHER the raw token nor any substring of it (deep-scan)", async () => {
    const h = await harness();
    const created = await createShareToken(h.orgId, {
      kind: "monthly_report",
      clientId: h.clientId,
    });
    if (!created.ok) throw new Error("create failed");

    // Pull the FULL row — every column, hash + ciphertext included — and prove
    // the capability itself never sits at rest anywhere on it.
    const row = await db.query.shareTokens.findFirst({
      where: eq(shareTokens.id, created.record.id),
    });
    expect(row).toBeTruthy();
    assertNoTokenLeak(row, created.token);
    // The lookup key is exactly sha256(token); the ciphertext exists but differs.
    expect(row?.tokenHash).toBe(createHash("sha256").update(created.token).digest("hex"));
    expect(row?.tokenCiphertext).toBeTruthy();
    expect(row?.tokenCiphertext).not.toContain(created.token);
  });

  it("resolves via the stored hash (not the raw token)", async () => {
    const h = await harness();
    const created = await createShareToken(h.orgId, {
      kind: "monthly_report",
      clientId: h.clientId,
    });
    if (!created.ok) throw new Error("create failed");

    // The row is found by hashing the presented token and matching token_hash.
    const byHash = await db.query.shareTokens.findFirst({
      where: eq(
        shareTokens.tokenHash,
        createHash("sha256").update(created.token).digest("hex"),
      ),
      columns: { id: true },
    });
    expect(byHash?.id).toBe(created.record.id);
    // And resolveShareToken (which does that hashing internally) agrees.
    const resolved = await resolveShareToken(created.token);
    expect(resolved?.id).toBe(created.record.id);
    // A wrong token hashes to a different digest → no match.
    expect(await resolveShareToken(generateShareTokenString())).toBeNull();
  });

  it("owner reveal decrypts the ciphertext back to the ORIGINAL link", async () => {
    const h = await harness();
    const created = await createShareToken(h.orgId, {
      kind: "monthly_report",
      clientId: h.clientId,
    });
    if (!created.ok) throw new Error("create failed");

    const revealed = await revealShareLink(h.orgId, created.record.id);
    expect(revealed.ok).toBe(true);
    if (!revealed.ok) return;
    // Byte-for-byte the same token minted — and it still resolves.
    expect(revealed.token).toBe(created.token);
    const resolved = await resolveShareToken(revealed.token);
    expect(resolved?.id).toBe(created.record.id);
  });

  it("refuses to reveal another org's token (org-scoped, not_found)", async () => {
    const owner = await harness();
    const stranger = await harness();
    const created = await createShareToken(owner.orgId, {
      kind: "monthly_report",
      clientId: owner.clientId,
    });
    if (!created.ok) throw new Error("create failed");

    const revealed = await revealShareLink(stranger.orgId, created.record.id);
    expect(revealed.ok).toBe(false);
    if (!revealed.ok) expect(revealed.error).toBe("not_found");
  });
});
