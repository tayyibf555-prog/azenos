import { db, projectKeys, projects } from "@azen/db";
import { decryptSecret, verifySecretAgainstHash } from "@azen/db/keys";
import {
  SIGNATURE_HEADER,
  TOKEN_HEADER,
  verifySignature,
} from "@azen/events/signing";
import { and, eq, isNull } from "drizzle-orm";

/** §6.3 steps 2–3: key lookup + request authentication. */

export interface IngestKey {
  keyId: string;
  orgId: string;
  projectId: string;
  clientId: string;
  projectName: string;
  authMode: "hmac" | "token";
  /** Phase 7 §B least privilege: only 'ingest' keys may drive this route. */
  kind: "ingest" | "feedback";
  rateLimitPer10s: number;
  secretHash: string;
  secretCiphertext: string;
}

/** Unknown and revoked keys are indistinguishable to callers (both 401). */
export async function lookupKey(publicKey: string): Promise<IngestKey | null> {
  const [row] = await db
    .select({
      keyId: projectKeys.id,
      orgId: projectKeys.orgId,
      projectId: projectKeys.projectId,
      clientId: projects.clientId,
      projectName: projects.name,
      authMode: projectKeys.authMode,
      kind: projectKeys.kind,
      rateLimitPer10s: projectKeys.rateLimitPer10s,
      secretHash: projectKeys.secretHash,
      secretCiphertext: projectKeys.secretCiphertext,
    })
    .from(projectKeys)
    .innerJoin(projects, eq(projects.id, projectKeys.projectId))
    .where(
      and(eq(projectKeys.publicKey, publicKey), isNull(projectKeys.revokedAt)),
    )
    .limit(1);
  return row ?? null;
}

export type AuthResult =
  | { ok: true }
  | {
      /** Caller gets a generic 401; `reason` goes to the delivery log only (§15). */
      ok: false;
      reason: string;
    };

export function authenticate(
  key: IngestKey,
  rawBody: string,
  headers: Headers,
): AuthResult {
  if (key.authMode === "token") {
    const token = headers.get(TOKEN_HEADER);
    if (!token) return { ok: false, reason: "token missing" };
    return verifySecretAgainstHash(token, key.secretHash)
      ? { ok: true }
      : { ok: false, reason: "token mismatch" };
  }
  const result = verifySignature(
    decryptSecret(key.secretCiphertext),
    rawBody,
    headers.get(SIGNATURE_HEADER),
  );
  return result.ok
    ? { ok: true }
    : { ok: false, reason: `signature ${result.reason}` };
}
