import { NextResponse } from "next/server";
import {
  VaultUnavailableError,
  createCredential,
  listCredentials,
} from "../../../../../lib/server/credentials";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import { projectExists } from "../../../../../lib/server/queries";
import {
  credentialCreateSchema,
  isUuid,
  readJsonBody,
  zodSummary,
} from "../../../../../lib/server/schemas";

/**
 * Connections Vault collection route (docs/phase7/PLAN.md §C1).
 *   GET  → non-revoked masked credentials for this project (no secrets).
 *   POST → store an owner-typed secret encrypted at rest; returns the masked
 *          view ONLY ({ id, provider, label, last4 }) — never the plaintext.
 *
 * Cross-org/project ids resolve to 404 (project scoping). A missing/invalid
 * INGEST_SECRET_ENC_KEY surfaces as 503 `vault_unavailable`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId)))
    return jsonError(404, "project_not_found");

  return NextResponse.json({ credentials: await listCredentials(orgId, projectId) });
});

export const POST = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId)))
    return jsonError(404, "project_not_found");

  const parsed = credentialCreateSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  try {
    const credential = await createCredential(orgId, projectId, parsed.data);
    return NextResponse.json({ credential }, { status: 201 });
  } catch (err) {
    if (err instanceof VaultUnavailableError)
      return jsonError(503, "vault_unavailable");
    throw err;
  }
});
