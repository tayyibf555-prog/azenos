import { db, projectKeys, projects, webhookDeliveries } from "@azen/db";
import { and, eq } from "drizzle-orm";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import {
  processIngestBody,
  sourceForAuthMode,
} from "../../../../../lib/server/ingest/pipeline";
import { requireOrgId } from "../../../../../lib/server/org";

export const runtime = "nodejs";

/**
 * Dead-letter recovery (§6.3): re-runs pipeline steps 5–10 on a rejected/
 * failed delivery's kept raw payload — size/auth/rate gates are skipped, the
 * caller is org-authenticated. A NEW delivery row records the outcome.
 */
export const POST = withErrorHandling(
  async (_req: Request, ctx: { params: Promise<{ deliveryId: string }> }) => {
    const orgId = await requireOrgId();
    const { deliveryId } = await ctx.params;

    const [delivery] = await db
      .select({
        id: webhookDeliveries.id,
        projectKeyId: webhookDeliveries.projectKeyId,
        raw: webhookDeliveries.raw,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.orgId, orgId),
        ),
      )
      .limit(1);
    if (!delivery) return jsonError(404, "not_found");
    if (delivery.raw === null || delivery.raw === undefined) {
      return jsonError(409, "nothing_to_replay");
    }
    if (!delivery.projectKeyId) return jsonError(404, "not_found");

    // key context by id — revoked keys can still replay their dead letters
    const [key] = await db
      .select({
        keyId: projectKeys.id,
        orgId: projectKeys.orgId,
        projectId: projectKeys.projectId,
        clientId: projects.clientId,
        projectName: projects.name,
        authMode: projectKeys.authMode,
      })
      .from(projectKeys)
      .innerJoin(projects, eq(projects.id, projectKeys.projectId))
      .where(eq(projectKeys.id, delivery.projectKeyId))
      .limit(1);
    if (!key) return jsonError(404, "not_found");

    return processIngestBody({
      body: delivery.raw,
      ctx: {
        keyId: key.keyId,
        orgId: key.orgId,
        projectId: key.projectId,
        clientId: key.clientId,
        projectName: key.projectName,
        source: sourceForAuthMode(key.authMode),
      },
      startedAt: performance.now(),
      rawForRejected: delivery.raw,
      usedPostgresRateLimit: false,
      errorOverride: `replay of ${delivery.id}`,
    });
  },
);
