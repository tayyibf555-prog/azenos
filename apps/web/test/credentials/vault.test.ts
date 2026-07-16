import { randomUUID } from "node:crypto";
import { db, projectCredentials } from "@azen/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createCredential,
  getDecryptedCredential,
  listCredentials,
  revokeCredential,
} from "../../lib/server/credentials";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
} from "../metrics-api/helpers";

/**
 * Connections Vault (docs/phase7/PLAN.md §C1 — security-critical). Two throwaway
 * orgs (never DEMO_ORG_ID), torn down in afterAll (project cascade also removes
 * project_credentials). We prove the hard rules: plaintext never appears in any
 * response, decrypt round-trips exactly, revocation excludes from the list, and
 * cross-org/project ids resolve to "not found" — at BOTH the server-core layer
 * and the HTTP-route layer.
 */

// requireOrgId is mocked to a mutable holder so a single test can flip which org
// "the caller" is (cross-org route checks) without new module instances.
const orgHolder = vi.hoisted(() => ({ id: "" }));
vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => orgHolder.id };
});

// vi.mock is hoisted above these imports, so the route handlers bind to the
// mocked requireOrgId.
import {
  GET as listRoute,
  POST as createRoute,
} from "../../app/api/projects/[projectId]/credentials/route";
import { DELETE as revokeRoute } from "../../app/api/projects/[projectId]/credentials/[credId]/route";

// A long, unique secret whose FULL value must never surface in any response.
// last4 ("Zk9q") is the only fragment allowed to appear.
const SECRET = "sk-ant-api03-VAULT-1a2b3c4d5e6f7g8h9i0j-Zk9q";
const LAST4 = "Zk9q";

interface Ctx {
  orgA: string;
  orgB: string;
  projectA: string;
  projectB: string;
}

const ctx: Ctx = { orgA: "", orgB: "", projectA: "", projectB: "" };

beforeAll(async () => {
  ctx.orgA = randomUUID();
  ctx.orgB = randomUUID();
  await createOrg(ctx.orgA);
  await createOrg(ctx.orgB);
  const clientA = await createClient(ctx.orgA);
  const clientB = await createClient(ctx.orgB);
  ctx.projectA = await createProject(ctx.orgA, clientA);
  ctx.projectB = await createProject(ctx.orgB, clientB);
});

afterAll(async () => {
  await cleanupOrg(ctx.orgA);
  await cleanupOrg(ctx.orgB);
});

/** Assert `needle` appears nowhere in a value's full JSON serialization. */
function assertAbsentDeep(value: unknown, needle: string, where: string): void {
  const serialized = JSON.stringify(value);
  expect(serialized, `${where}: full secret must be absent`).not.toContain(
    needle,
  );
}

function makeCtx(projectId: string, credId?: string) {
  return {
    params: Promise.resolve(
      credId ? { projectId, credId } : { projectId },
    ),
  } as never;
}

describe("vault server core", () => {
  it("create returns {id, provider, label, last4} ONLY — no secret", async () => {
    const summary = await createCredential(ctx.orgA, ctx.projectA, {
      provider: "anthropic",
      label: "Prod Anthropic",
      secret: SECRET,
    });

    expect(summary).toEqual({
      id: expect.any(String),
      provider: "anthropic",
      label: "Prod Anthropic",
      last4: LAST4,
    });
    // The whole return value must not carry the plaintext or ciphertext.
    assertAbsentDeep(summary, SECRET, "createCredential result");
  });

  it("list shows masked rows only; deep-scan finds no secret", async () => {
    const rows = await listCredentials(ctx.orgA, ctx.projectA);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    if (!row) throw new Error("expected at least one credential");
    expect(Object.keys(row).sort()).toEqual([
      "createdAt",
      "id",
      "label",
      "last4",
      "provider",
    ]);
    expect(row.last4).toBe(LAST4);
    assertAbsentDeep(rows, SECRET, "listCredentials rows");
  });

  it("decrypt round-trips exactly (server-internal only)", async () => {
    const created = await createCredential(ctx.orgA, ctx.projectA, {
      provider: "openai",
      label: "Round-trip",
      secret: SECRET,
    });
    const plaintext = await getDecryptedCredential(
      ctx.orgA,
      ctx.projectA,
      created.id,
    );
    expect(plaintext).toBe(SECRET);
  });

  it("revoke removes the credential from the list", async () => {
    const created = await createCredential(ctx.orgA, ctx.projectA, {
      provider: "twilio",
      label: "To revoke",
      secret: SECRET,
    });
    expect(
      (await listCredentials(ctx.orgA, ctx.projectA)).map((r) => r.id),
    ).toContain(created.id);

    const ok = await revokeCredential(ctx.orgA, ctx.projectA, created.id);
    expect(ok).toBe(true);
    expect(
      (await listCredentials(ctx.orgA, ctx.projectA)).map((r) => r.id),
    ).not.toContain(created.id);

    // Re-revoking a revoked/absent row is a no-op (→ 404 at the route).
    expect(await revokeCredential(ctx.orgA, ctx.projectA, created.id)).toBe(
      false,
    );
    // A revoked credential can no longer be decrypted.
    expect(
      await getDecryptedCredential(ctx.orgA, ctx.projectA, created.id),
    ).toBeNull();
  });

  it("cross-org and cross-project access resolves to not-found", async () => {
    const created = await createCredential(ctx.orgA, ctx.projectA, {
      provider: "higgsfield",
      label: "Scoped",
      secret: SECRET,
    });
    // Wrong org can neither see, decrypt, nor revoke it.
    expect(await listCredentials(ctx.orgB, ctx.projectA)).toEqual([]);
    expect(
      await getDecryptedCredential(ctx.orgB, ctx.projectA, created.id),
    ).toBeNull();
    expect(await revokeCredential(ctx.orgB, ctx.projectA, created.id)).toBe(
      false,
    );
    // Right org but wrong project is equally blind.
    expect(
      await getDecryptedCredential(ctx.orgA, ctx.projectB, created.id),
    ).toBeNull();
    expect(await revokeCredential(ctx.orgA, ctx.projectB, created.id)).toBe(
      false,
    );
    // Still intact for the rightful owner.
    expect(
      await getDecryptedCredential(ctx.orgA, ctx.projectA, created.id),
    ).toBe(SECRET);
  });
});

describe("vault routes", () => {
  it("POST create → 201, GET list → masked; deep-scan finds no secret", async () => {
    orgHolder.id = ctx.orgA;

    const createRes = await createRoute(
      new Request("http://t/api/projects/x/credentials", {
        method: "POST",
        body: JSON.stringify({
          provider: "custom",
          label: "Route card",
          secret: SECRET,
        }),
      }),
      makeCtx(ctx.projectA),
    );
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody).toEqual({
      credential: {
        id: expect.any(String),
        provider: "custom",
        label: "Route card",
        last4: LAST4,
      },
    });
    assertAbsentDeep(createBody, SECRET, "POST response body");

    const listRes = await listRoute(
      new Request("http://t/api/projects/x/credentials"),
      makeCtx(ctx.projectA),
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(Array.isArray(listBody.credentials)).toBe(true);
    expect(
      listBody.credentials.some(
        (c: { id: string }) => c.id === createBody.credential.id,
      ),
    ).toBe(true);
    assertAbsentDeep(listBody, SECRET, "GET list response body");
  });

  it("DELETE revoke → 200 then gone; re-DELETE → 404", async () => {
    orgHolder.id = ctx.orgA;
    const created = await createCredential(ctx.orgA, ctx.projectA, {
      provider: "anthropic",
      label: "Route revoke",
      secret: SECRET,
    });

    const del = await revokeRoute(
      new Request("http://t", { method: "DELETE" }),
      makeCtx(ctx.projectA, created.id),
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const again = await revokeRoute(
      new Request("http://t", { method: "DELETE" }),
      makeCtx(ctx.projectA, created.id),
    );
    expect(again.status).toBe(404);
  });

  it("cross-org caller cannot list another org's project (404)", async () => {
    orgHolder.id = ctx.orgB; // caller is org B
    const res = await listRoute(
      new Request("http://t"),
      makeCtx(ctx.projectA), // ...asking for org A's project
    );
    expect(res.status).toBe(404);
  });

  it("cross-org caller cannot revoke another org's credential (404)", async () => {
    // Credential belongs to org A / project A.
    const created = await createCredential(ctx.orgA, ctx.projectA, {
      provider: "openai",
      label: "Protected",
      secret: SECRET,
    });
    orgHolder.id = ctx.orgB;
    const res = await revokeRoute(
      new Request("http://t", { method: "DELETE" }),
      makeCtx(ctx.projectA, created.id),
    );
    expect(res.status).toBe(404);
    // Untouched: org A can still decrypt it.
    expect(
      await getDecryptedCredential(ctx.orgA, ctx.projectA, created.id),
    ).toBe(SECRET);
  });

  it("oversize secret → 400", async () => {
    orgHolder.id = ctx.orgA;
    const res = await createRoute(
      new Request("http://t", {
        method: "POST",
        body: JSON.stringify({
          provider: "custom",
          label: "Too big",
          secret: "x".repeat(4097),
        }),
      }),
      makeCtx(ctx.projectA),
    );
    expect(res.status).toBe(400);
  });

  it("too-short secret and over-long label → 400", async () => {
    orgHolder.id = ctx.orgA;
    const short = await createRoute(
      new Request("http://t", {
        method: "POST",
        body: JSON.stringify({ provider: "custom", label: "ok", secret: "1234567" }),
      }),
      makeCtx(ctx.projectA),
    );
    expect(short.status).toBe(400);

    const longLabel = await createRoute(
      new Request("http://t", {
        method: "POST",
        body: JSON.stringify({
          provider: "custom",
          label: "L".repeat(61),
          secret: SECRET,
        }),
      }),
      makeCtx(ctx.projectA),
    );
    expect(longLabel.status).toBe(400);
  });

  it("missing INGEST_SECRET_ENC_KEY → 503 vault_unavailable", async () => {
    orgHolder.id = ctx.orgA;
    const saved = process.env.INGEST_SECRET_ENC_KEY;
    delete process.env.INGEST_SECRET_ENC_KEY;
    try {
      const res = await createRoute(
        new Request("http://t", {
          method: "POST",
          body: JSON.stringify({
            provider: "anthropic",
            label: "No vault",
            secret: SECRET,
          }),
        }),
        makeCtx(ctx.projectA),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "vault_unavailable" });
    } finally {
      if (saved !== undefined) process.env.INGEST_SECRET_ENC_KEY = saved;
    }
  });

  it("unknown project id → 404 on create and list", async () => {
    orgHolder.id = ctx.orgA;
    const unknown = randomUUID();
    const createRes = await createRoute(
      new Request("http://t", {
        method: "POST",
        body: JSON.stringify({
          provider: "custom",
          label: "Nowhere",
          secret: SECRET,
        }),
      }),
      makeCtx(unknown),
    );
    expect(createRes.status).toBe(404);

    const listRes = await listRoute(new Request("http://t"), makeCtx(unknown));
    expect(listRes.status).toBe(404);
  });

  it("stored ciphertext never equals plaintext (encrypted at rest)", async () => {
    const created = await createCredential(ctx.orgA, ctx.projectA, {
      provider: "custom",
      label: "At rest",
      secret: SECRET,
    });
    const [row] = await db
      .select({ ciphertext: projectCredentials.ciphertext })
      .from(projectCredentials)
      .where(eq(projectCredentials.id, created.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.ciphertext).not.toContain(SECRET);
    expect(row!.ciphertext.startsWith("v1:")).toBe(true);
  });
});
