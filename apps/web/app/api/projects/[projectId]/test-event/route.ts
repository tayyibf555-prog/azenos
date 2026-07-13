import { randomUUID } from "node:crypto";
import { db, projectKeys, projects } from "@azen/db";
import { decryptSecret } from "@azen/db/keys";
import {
  SIGNATURE_HEADER,
  TOKEN_HEADER,
  signBody,
} from "@azen/events/signing";
import { and, desc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import { POST as ingestPOST } from "../../../ingest/[publicKey]/route";

export const runtime = "nodejs";

/**
 * Setup tab "Send test event": signs a custom.azen_test event with the
 * project's active key and pushes it through the real ingest handler by
 * direct invocation — no network hop, but every pipeline step runs.
 */
export const POST = withErrorHandling(
  async (_req: Request, ctx: { params: Promise<{ projectId: string }> }) => {
    const orgId = await requireOrgId();
    const { projectId } = await ctx.params;

    const [key] = await db
      .select({
        publicKey: projectKeys.publicKey,
        authMode: projectKeys.authMode,
        secretCiphertext: projectKeys.secretCiphertext,
      })
      .from(projectKeys)
      .innerJoin(projects, eq(projects.id, projectKeys.projectId))
      .where(
        and(
          eq(projectKeys.projectId, projectId),
          eq(projects.orgId, orgId),
          isNull(projectKeys.revokedAt),
        ),
      )
      .orderBy(desc(projectKeys.createdAt))
      .limit(1);
    if (!key) return jsonError(404, "not_found");

    const eventType = "custom.azen_test";
    const body = JSON.stringify({
      type: eventType,
      occurred_at: new Date().toISOString(),
      idempotency_key: `test:${randomUUID()}`,
      data: { note: "Sent from the Setup tab" },
    });
    const secret = decryptSecret(key.secretCiphertext);
    const headers = new Headers({ "content-type": "application/json" });
    if (key.authMode === "token") headers.set(TOKEN_HEADER, secret);
    else headers.set(SIGNATURE_HEADER, signBody(secret, body));

    const res = await ingestPOST(
      new Request(`http://internal/api/ingest/${key.publicKey}`, {
        method: "POST",
        headers,
        body,
      }),
      { params: Promise.resolve({ publicKey: key.publicKey }) },
    );
    const result = (await res.json()) as Record<string, unknown>;
    return NextResponse.json({ ...result, eventType }, { status: res.status });
  },
);
