import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, db, projectKeys } from "@azen/db";
import { decryptSecret, verifySecretAgainstHash } from "@azen/db/keys";
import {
  cleanupOrg,
  createOrg,
  createTestClient,
  createTestKey,
  createTestProject,
} from "./helpers";

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { POST as ROTATE } from "../../app/api/projects/[projectId]/keys/rotate/route";
import { POST as REVOKE } from "../../app/api/projects/[projectId]/keys/revoke/route";

let projectId: string;
let bareProjectId: string;
let keyId: string;
let publicKey: string;
let originalSecret: string;

function post(
  handler: typeof ROTATE,
  id: string,
  path: string,
): Promise<Response> {
  return handler(
    new Request(`http://test.local/api/projects/${id}/keys/${path}`, {
      method: "POST",
    }),
    { params: Promise.resolve({ projectId: id }) },
  );
}

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createTestClient(TEST_ORG_ID);
  projectId = await createTestProject(TEST_ORG_ID, clientId);
  bareProjectId = await createTestProject(TEST_ORG_ID, clientId);
  const key = await createTestKey(TEST_ORG_ID, projectId, {
    rateLimitPer10s: 42,
  });
  keyId = key.keyId;
  publicKey = key.publicKey;
  originalSecret = key.secret;
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

describe("POST /api/projects/[projectId]/keys/rotate", () => {
  it("issues a new secret on the same public key and kills the old one", async () => {
    const res = await post(ROTATE, projectId, "rotate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicKey: string; secret: string };
    expect(Object.keys(body).sort()).toEqual(["publicKey", "secret"]);
    expect(body.publicKey).toBe(publicKey);
    expect(body.secret).toMatch(/^azn_sk_[0-9a-f]{64}$/);
    expect(body.secret).not.toBe(originalSecret);

    const [row] = await db
      .select()
      .from(projectKeys)
      .where(eq(projectKeys.id, keyId));
    if (!row) throw new Error("key row missing");
    expect(row.revokedAt).toBeNull();
    expect(verifySecretAgainstHash(originalSecret, row.secretHash)).toBe(false);
    expect(verifySecretAgainstHash(body.secret, row.secretHash)).toBe(true);
    expect(decryptSecret(row.secretCiphertext)).toBe(body.secret);
  });

  it("404s when the project has no active key", async () => {
    const res = await post(ROTATE, bareProjectId, "rotate");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "no_active_key",
    );
  });

  it("404s a projectId that is not in this org", async () => {
    const res = await post(ROTATE, crypto.randomUUID(), "rotate");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "project_not_found",
    );
  });
});

describe("POST /api/projects/[projectId]/keys/revoke", () => {
  it("revokes the active key and re-issues a fresh pair inheriting its config", async () => {
    const res = await post(REVOKE, projectId, "revoke");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publicKey: string;
      secret: string;
      authMode: string;
    };
    expect(Object.keys(body).sort()).toEqual([
      "authMode",
      "publicKey",
      "secret",
    ]);
    expect(body.publicKey).not.toBe(publicKey);
    expect(body.publicKey).toMatch(/^azn_pk_[0-9a-f]{24}$/);
    expect(body.authMode).toBe("hmac");

    const [oldRow] = await db
      .select()
      .from(projectKeys)
      .where(eq(projectKeys.id, keyId));
    expect(oldRow?.revokedAt).toBeInstanceOf(Date);

    const active = await db
      .select()
      .from(projectKeys)
      .where(
        and(
          eq(projectKeys.projectId, projectId),
          isNull(projectKeys.revokedAt),
        ),
      );
    expect(active).toHaveLength(1);
    const fresh = active[0];
    if (!fresh) throw new Error("fresh key missing");
    expect(fresh.publicKey).toBe(body.publicKey);
    expect(fresh.rateLimitPer10s).toBe(42);
    expect(fresh.authMode).toBe("hmac");
    expect(verifySecretAgainstHash(body.secret, fresh.secretHash)).toBe(true);
  });

  it("404s when nothing is active to revoke", async () => {
    const res = await post(REVOKE, bareProjectId, "revoke");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "no_active_key",
    );
  });
});
