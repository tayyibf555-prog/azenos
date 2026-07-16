import { randomUUID } from "node:crypto";
import {
  clients,
  closeDb,
  db,
  organizations,
  projectKeys,
  projects,
} from "@azen/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createProject } from "../../lib/server/queries";

async function teardownOrg(orgId: string): Promise<void> {
  await db.delete(projectKeys).where(eq(projectKeys.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(clients).where(eq(clients.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
}

/**
 * Phase 7 §B provisioning: creating a project must mint BOTH an ingest key and
 * a public feedback-widget key (least privilege, ready to embed immediately).
 */
describe("createProject provisions a feedback key", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("mints one ingest key and one feedback key", async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({ id: orgId, name: "Prov Test" });

    try {
      const result = await createProject(orgId, {
        name: `Prov ${orgId.slice(0, 8)}`,
        type: "ai_agent",
        newClient: { name: "Prov Client" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // the create result surfaces the public feedback key (no secret)
      expect(result.feedbackPublicKey).toMatch(/^azn_fb_/);

      const keys = await db
        .select({
          publicKey: projectKeys.publicKey,
          kind: projectKeys.kind,
          secretCiphertext: projectKeys.secretCiphertext,
        })
        .from(projectKeys)
        .where(
          and(
            eq(projectKeys.orgId, orgId),
            eq(projectKeys.projectId, result.project.id),
          ),
        );

      const ingest = keys.filter((k) => k.kind === "ingest");
      const feedback = keys.filter((k) => k.kind === "feedback");
      expect(ingest).toHaveLength(1);
      expect(feedback).toHaveLength(1);
      expect(feedback[0]!.publicKey).toBe(result.feedbackPublicKey);
      expect(feedback[0]!.publicKey).toMatch(/^azn_fb_/);
      // feedback keys ship NO usable secret ciphertext
      expect(feedback[0]!.secretCiphertext).toBe("");
    } finally {
      await teardownOrg(orgId);
    }
  });
});
