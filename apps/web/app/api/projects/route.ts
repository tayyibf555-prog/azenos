import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../lib/server/http";
import { requireOrgId } from "../../../lib/server/org";
import { createProject, listProjects } from "../../../lib/server/queries";
import {
  projectCreateSchema,
  readJsonBody,
  zodSummary,
} from "../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async () => {
  const orgId = await requireOrgId();
  return NextResponse.json({ projects: await listProjects(orgId) });
});

export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = projectCreateSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  const result = await createProject(orgId, parsed.data);
  if (!result.ok) return jsonError(404, result.error);
  // The ONLY response containing the plaintext secret, besides rotate/revoke.
  // The feedback key is PUBLIC (no secret) — safe to surface for the widget.
  return NextResponse.json(
    {
      project: result.project,
      key: result.key,
      feedbackPublicKey: result.feedbackPublicKey,
    },
    { status: 201 },
  );
});
