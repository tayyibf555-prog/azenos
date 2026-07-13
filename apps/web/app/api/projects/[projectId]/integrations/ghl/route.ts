import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, projectIntegrations } from "@azen/db";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import { projectExists } from "../../../../../../lib/server/queries";
import { isUuid } from "../../../../../../lib/server/schemas";
import { GHL_DEFAULT_MAPPING_ID } from "../../../../../../lib/server/integrations/ghl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * Enable the GHL preset on a project (§P6-SDK-PY). Stores (or updates) a single
 * `project_integrations` row with provider 'ghl' and config
 * { mapping: "ghl-default-v1" }, optionally stamping the GHL location id as the
 * externalId. Idempotent — re-posting updates the existing row rather than
 * creating a duplicate.
 */
export const POST = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId)))
    return jsonError(404, "project_not_found");

  let externalId: string | null = null;
  try {
    const raw: unknown = await req.json();
    if (raw && typeof raw === "object") {
      const v = (raw as Record<string, unknown>)["externalId"];
      if (typeof v === "string" && v.trim() !== "") externalId = v.trim();
    }
  } catch {
    // empty / non-JSON body → no externalId, preset still enabled
  }

  const config = { mapping: GHL_DEFAULT_MAPPING_ID };

  const [existing] = await db
    .select({ id: projectIntegrations.id })
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.orgId, orgId),
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.provider, "ghl"),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(projectIntegrations)
      .set({ config, ...(externalId ? { externalId } : {}) })
      .where(eq(projectIntegrations.id, existing.id));
    return NextResponse.json({
      integrationId: existing.id,
      provider: "ghl",
      mapping: GHL_DEFAULT_MAPPING_ID,
      updated: true,
    });
  }

  const [row] = await db
    .insert(projectIntegrations)
    .values({ orgId, projectId, provider: "ghl", externalId, config })
    .returning({ id: projectIntegrations.id });

  return NextResponse.json({
    integrationId: row!.id,
    provider: "ghl",
    mapping: GHL_DEFAULT_MAPPING_ID,
    updated: false,
  });
});
