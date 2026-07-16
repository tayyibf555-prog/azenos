import { NextResponse } from "next/server";
import { revokeCredential } from "../../../../../../lib/server/credentials";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import { projectExists } from "../../../../../../lib/server/queries";
import { isUuid } from "../../../../../../lib/server/schemas";

/**
 * Connections Vault item route (docs/phase7/PLAN.md §C1).
 *   DELETE → revoke (soft-delete) a credential so it drops out of the list.
 *
 * Org + project scoped: a credential from another org/project, an unknown id,
 * or an already-revoked one all resolve to 404 — nothing is decrypted or
 * returned. No plaintext ever touches this path.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; credId: string }> };

export const DELETE = withErrorHandling(
  async (_req: Request, { params }: Ctx) => {
    const orgId = await requireOrgId();
    const { projectId, credId } = await params;
    if (!isUuid(projectId)) return jsonError(404, "project_not_found");
    if (!isUuid(credId)) return jsonError(404, "credential_not_found");
    if (!(await projectExists(orgId, projectId)))
      return jsonError(404, "project_not_found");

    const revoked = await revokeCredential(orgId, projectId, credId);
    if (!revoked) return jsonError(404, "credential_not_found");
    return NextResponse.json({ ok: true });
  },
);
