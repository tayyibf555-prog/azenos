import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withErrorHandling } from "../../../lib/server/http";
import { requireOrgId } from "../../../lib/server/org";
import { isUuid, readJsonBody, zodSummary } from "../../../lib/server/schemas";
import {
  createShareToken,
  revealShareLink,
  revokeShareToken,
} from "../../../lib/server/share";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    kind: z.enum(["monthly_report", "proposal"]),
    clientId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    proposalId: z.uuid().optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((v) => v.kind !== "monthly_report" || v.clientId != null, {
    message: "clientId required for monthly_report",
    path: ["clientId"],
  })
  .refine((v) => v.kind !== "proposal" || v.proposalId != null, {
    message: "proposalId required for proposal",
    path: ["proposalId"],
  });

const deleteSchema = z.object({ tokenId: z.uuid() });

// POST /api/share — mint a share token (org-scoped; cross-org refs refused).
export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = createSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  // Forward ONLY the id this kind is keyed on — the secondary references a token
  // carries are derived org-side from the validated entity, never from the
  // client, so a caller can't smuggle a foreign-org projectId/proposalId here.
  const d = parsed.data;
  const result = await createShareToken(
    orgId,
    d.kind === "monthly_report"
      ? { kind: d.kind, clientId: d.clientId, expiresAt: d.expiresAt }
      : { kind: d.kind, proposalId: d.proposalId, expiresAt: d.expiresAt },
  );
  if (!result.ok) {
    if (result.error === "not_found") return jsonError(404, "not_found");
    if (result.error === "enc_key_missing") {
      return jsonError(503, "share_unavailable");
    }
    return jsonError(400, "invalid_input");
  }
  // The raw token is the capability — returned ONCE here (mint). The record is
  // token-free metadata; `token` is the one-time raw string the owner copies.
  return NextResponse.json(
    { record: result.record, token: result.token },
    { status: 201 },
  );
});

// GET /api/share?tokenId=… — owner-only "copy link again": decrypt an existing
// token's ciphertext back to its raw link for the AUTHENTICATED owner. Org-scoped
// (unknown / cross-org id → 404); never a public path. No key configured → 503.
export const GET = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const tokenId = new URL(req.url).searchParams.get("tokenId");
  if (!tokenId || !isUuid(tokenId)) return jsonError(400, "invalid_input");

  const result = await revealShareLink(orgId, tokenId);
  if (!result.ok) {
    if (result.error === "enc_key_missing") {
      return jsonError(503, "share_unavailable");
    }
    return jsonError(404, "not_found");
  }
  return NextResponse.json({ token: result.token });
});

// DELETE /api/share — revoke a token (org-scoped). Body: { tokenId }.
export const DELETE = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = deleteSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const ok = await revokeShareToken(orgId, parsed.data.tokenId);
  if (!ok) return jsonError(404, "not_found");
  return NextResponse.json({ revoked: true });
});
