import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db, industries, projectKeys } from "@azen/db";
import { decryptSecret, sha256Hex, verifySecretAgainstHash } from "@azen/db/keys";
import { cleanupOrg, createOrg } from "./helpers";

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { POST } from "../../app/api/projects/route";
import { GET as GET_DETAIL } from "../../app/api/projects/[projectId]/route";

const runTag = TEST_ORG_ID.slice(0, 8);
const projectName = `Create Flow ${runTag}`;

function postProjects(body: unknown): Promise<Response> {
  return POST(
    new Request("http://test.local/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

interface CreateResponse {
  project: { id: string; clientId: string; slug: string; status: string; retainerPenceMonthly: number };
  key: { publicKey: string; secret: string; authMode: string };
}

let created: CreateResponse;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

describe("POST /api/projects", () => {
  it("creates client+project+key and returns the secret exactly once", async () => {
    const res = await postProjects({
      name: projectName,
      type: "chatbot",
      retainerPenceMonthly: 25_000,
      newClient: { name: "Created Client", industrySlug: `test-ind-${runTag}` },
    });
    expect(res.status).toBe(201);
    created = (await res.json()) as CreateResponse;

    expect(created.key.publicKey).toMatch(/^azn_pk_[0-9a-f]{24}$/);
    expect(created.key.secret).toMatch(/^azn_sk_[0-9a-f]{64}$/);
    expect(created.key.authMode).toBe("hmac");
    expect(created.project.status).toBe("building");
    expect(created.project.retainerPenceMonthly).toBe(25_000);

    // stored material corresponds to the returned plaintext
    const [keyRow] = await db
      .select()
      .from(projectKeys)
      .where(eq(projectKeys.publicKey, created.key.publicKey));
    if (!keyRow) throw new Error("key row missing");
    expect(keyRow.secretHash).toBe(sha256Hex(created.key.secret));
    expect(verifySecretAgainstHash(created.key.secret, keyRow.secretHash)).toBe(
      true,
    );
    expect(decryptSecret(keyRow.secretCiphertext)).toBe(created.key.secret);

    // unknown industry slug → created, named from the slug
    const [industry] = await db
      .select()
      .from(industries)
      .where(eq(industries.slug, `test-ind-${runTag}`));
    expect(industry?.name).toBe(`Test Ind ${runTag.charAt(0).toUpperCase()}${runTag.slice(1)}`);
  });

  it("suffixes the slug on collision and issues an hmac key", async () => {
    const res = await postProjects({
      name: projectName,
      type: "chatbot",
      stack: "mixed",
      clientId: created.project.clientId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateResponse;
    expect(body.project.slug).toBe(`${created.project.slug}-2`);
    expect(body.key.authMode).toBe("hmac");
  });

  it("rejects clientId+newClient together (XOR)", async () => {
    const res = await postProjects({
      name: "XOR Case",
      type: "custom",
      clientId: created.project.clientId,
      newClient: { name: "Extra" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("exactly one of clientId or newClient");
  });

  it("404s a clientId that is not in this org", async () => {
    const res = await postProjects({
      name: "Ghost Client Case",
      type: "custom",
      clientId: crypto.randomUUID(),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "client_not_found",
    );
  });

  it("never returns secret material again on read (detail keys are stripped)", async () => {
    const res = await GET_DETAIL(
      new Request(`http://test.local/api/projects/${created.project.id}`),
      { params: Promise.resolve({ projectId: created.project.id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: Record<string, unknown>[];
      eventTypesSeen: unknown[];
    };
    // Phase 7 §B: project creation provisions TWO keys — ingest + the public
    // feedback-widget key. Both must come back stripped to the same safe shape.
    expect(body.keys).toHaveLength(2);
    for (const key of body.keys) {
      expect(Object.keys(key).sort()).toEqual([
        "authMode",
        "createdAt",
        "id",
        "label",
        "lastUsedAt",
        "publicKey",
        "rateLimitPer10s",
        "revokedAt",
      ]);
    }
    expect(body.eventTypesSeen).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("azn_sk_");
  });
});
