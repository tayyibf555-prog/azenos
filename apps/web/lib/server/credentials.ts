import { db, projectCredentials } from "@azen/db";
import { decryptSecret, encryptSecret } from "@azen/db/keys";
import { and, desc, eq, isNull } from "drizzle-orm";

/**
 * Connections Vault server core (docs/phase7/PLAN.md §C1 — security-critical).
 *
 * Per-project third-party credentials (Anthropic / OpenAI / Twilio /
 * Higgsfield / custom) the OWNER types once. The plaintext secret is encrypted
 * at rest with AES-256-GCM under INGEST_SECRET_ENC_KEY (the proven
 * @azen/db/keys scheme) and NEVER leaves the server unmasked:
 *
 *   - createCredential  → returns { id, provider, label, last4 } ONLY.
 *   - listCredentials   → non-revoked masked rows ONLY (no ciphertext, no
 *                         plaintext) — the UI derives "sk-…{last4}" from last4.
 *   - revokeCredential  → sets revoked_at (soft-delete); it stays encrypted.
 *   - getDecryptedCredential → server-internal ONLY (future co-pilot runners).
 *     Exported for those runners but MUST NEVER be imported by any route that
 *     returns its value. No API in this codebase returns a decrypted secret.
 *
 * HARD RULES (§C1): plaintext never appears in any response, log line, or error
 * message; a missing INGEST_SECRET_ENC_KEY surfaces as a typed
 * VaultUnavailableError (→ 503 vault_unavailable); every read/write is
 * org + project scoped, so a cross-org/project id resolves to "not found".
 */

/** All five providers the vault accepts (mirrors the credential_provider enum). */
export type CredentialProvider =
  | "anthropic"
  | "openai"
  | "twilio"
  | "higgsfield"
  | "custom";

/**
 * What `createCredential` returns — {id, provider, label, last4} ONLY (§C1).
 * Never carries the secret or its ciphertext.
 */
export interface CredentialSummary {
  id: string;
  provider: CredentialProvider;
  label: string;
  /** Last 4 chars of the secret, for "····{last4}" display. Never more. */
  last4: string;
}

/**
 * What `listCredentials` returns — the summary plus `createdAt` so the
 * Connections tab can show the added date. Still masked; no secret/ciphertext.
 */
export interface MaskedCredential extends CredentialSummary {
  createdAt: string;
}

export interface CreateCredentialInput {
  provider: CredentialProvider;
  label: string;
  secret: string;
}

/**
 * INGEST_SECRET_ENC_KEY is unset (or invalid) → the vault cannot encrypt or
 * decrypt. Routes map this to a typed 503 `vault_unavailable` instead of a
 * generic 500 so the UI can say "vault not configured". Its message never
 * contains any secret material.
 */
export class VaultUnavailableError extends Error {
  constructor() {
    super("vault_unavailable");
    this.name = "VaultUnavailableError";
  }
}

/** True when the AES key is present and 32 bytes — i.e. encrypt/decrypt can run. */
export function vaultAvailable(): boolean {
  const raw = process.env.INGEST_SECRET_ENC_KEY;
  if (!raw) return false;
  try {
    return Buffer.from(raw, "base64").length === 32;
  } catch {
    return false;
  }
}

function assertVault(): void {
  if (!vaultAvailable()) throw new VaultUnavailableError();
}

/**
 * Encrypt `secret` and insert a project-scoped credential row.
 * Returns the masked view ONLY — the caller (and therefore the HTTP response)
 * never sees the plaintext or the ciphertext.
 * Throws VaultUnavailableError if the encryption key is missing/invalid.
 */
export async function createCredential(
  orgId: string,
  projectId: string,
  input: CreateCredentialInput,
): Promise<CredentialSummary> {
  assertVault();

  // last4 is the ONLY fragment of the secret ever persisted in the clear.
  const last4 = input.secret.slice(-4);
  const ciphertext = encryptSecret(input.secret);

  const [row] = await db
    .insert(projectCredentials)
    .values({
      orgId,
      projectId,
      provider: input.provider,
      label: input.label,
      ciphertext,
      last4,
    })
    .returning({
      id: projectCredentials.id,
      provider: projectCredentials.provider,
      label: projectCredentials.label,
      last4: projectCredentials.last4,
    });

  if (!row) {
    // Insert with .returning() always yields a row on success; a missing row
    // means the write failed without throwing. Never echo any input.
    throw new Error("credential insert returned no row");
  }

  return {
    id: row.id,
    provider: row.provider as CredentialProvider,
    label: row.label,
    last4: row.last4,
  };
}

/**
 * Non-revoked credentials for a project, newest first, MASKED — no ciphertext,
 * no plaintext. Cross-org/project rows never appear because both ids are in the
 * WHERE. Does not touch the encryption key, so it works even if the vault is
 * unavailable (nothing to decrypt).
 */
export async function listCredentials(
  orgId: string,
  projectId: string,
): Promise<MaskedCredential[]> {
  const rows = await db
    .select({
      id: projectCredentials.id,
      provider: projectCredentials.provider,
      label: projectCredentials.label,
      last4: projectCredentials.last4,
      createdAt: projectCredentials.createdAt,
    })
    .from(projectCredentials)
    .where(
      and(
        eq(projectCredentials.orgId, orgId),
        eq(projectCredentials.projectId, projectId),
        isNull(projectCredentials.revokedAt),
      ),
    )
    .orderBy(desc(projectCredentials.createdAt));

  return rows.map((r) => ({
    id: r.id,
    provider: r.provider as CredentialProvider,
    label: r.label,
    last4: r.last4,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Soft-delete a credential (set revoked_at). Org + project scoped and only
 * affects a still-active row, so it is idempotent and cross-org safe.
 * Returns true when a row was revoked, false when nothing matched (→ 404).
 */
export async function revokeCredential(
  orgId: string,
  projectId: string,
  credId: string,
): Promise<boolean> {
  const revoked = await db
    .update(projectCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(projectCredentials.id, credId),
        eq(projectCredentials.orgId, orgId),
        eq(projectCredentials.projectId, projectId),
        isNull(projectCredentials.revokedAt),
      ),
    )
    .returning({ id: projectCredentials.id });

  return revoked.length > 0;
}

/**
 * SERVER-INTERNAL ONLY (future co-pilot runners). Returns the DECRYPTED
 * plaintext secret for a still-active, org+project-scoped credential, or null
 * if not found / revoked. Throws VaultUnavailableError if the key is missing.
 *
 * ⚠️ NEVER import this from a route that returns its value, logs it, or places
 * it in an error. It exists purely so trusted server code can call a client's
 * provider on their behalf.
 */
export async function getDecryptedCredential(
  orgId: string,
  projectId: string,
  credId: string,
): Promise<string | null> {
  assertVault();

  const [row] = await db
    .select({ ciphertext: projectCredentials.ciphertext })
    .from(projectCredentials)
    .where(
      and(
        eq(projectCredentials.id, credId),
        eq(projectCredentials.orgId, orgId),
        eq(projectCredentials.projectId, projectId),
        isNull(projectCredentials.revokedAt),
      ),
    )
    .limit(1);

  if (!row) return null;
  return decryptSecret(row.ciphertext);
}
