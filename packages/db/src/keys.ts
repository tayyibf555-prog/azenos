import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Project key material (spec §6.1, §15).
 *
 * The spec says "secrets stored hashed", but a hash cannot verify an HMAC
 * signature — the server must recover the actual secret to recompute
 * HMAC(secret, body) (§6.2). Industry practice for webhook *signing* keys
 * (Stripe, Svix, GitHub) is recoverable storage. So (docs/DECISIONS.md):
 *   - secret_hash      sha256 — constant-time compare for token-mode auth
 *   - secret_ciphertext AES-256-GCM under INGEST_SECRET_ENC_KEY — decrypted
 *                       only inside the ingest verify step and test-event send
 * The plaintext secret is still shown once at creation/rotation and never
 * returned by any read API.
 *
 * Node-only (node:crypto): import via "@azen/db/keys", never from the root.
 */

const ENC_VERSION = "v1";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getEncKey(): Buffer {
  const raw = process.env.INGEST_SECRET_ENC_KEY;
  if (!raw) {
    throw new Error(
      "INGEST_SECRET_ENC_KEY is not set — generate one with `openssl rand -base64 32` and add it to .env",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("INGEST_SECRET_ENC_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

/** AES-256-GCM: "v1:" + base64(iv[12] | authTag[16] | ciphertext). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);
  return `${ENC_VERSION}:${packed.toString("base64")}`;
}

export function decryptSecret(ciphertext: string): string {
  const [version, payload] = ciphertext.split(":", 2);
  if (version !== ENC_VERSION || !payload) {
    throw new Error("unrecognized secret ciphertext format");
  }
  const packed = Buffer.from(payload, "base64");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ct = packed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getEncKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Constant-time token-mode check: candidate secret vs stored sha256 hash. */
export function verifySecretAgainstHash(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(sha256Hex(candidate), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GeneratedKeyPair {
  publicKey: string;
  /** Plaintext — show once, then store only hash + ciphertext. */
  secret: string;
  secretHash: string;
  secretCiphertext: string;
}

/**
 * azn_pk_<hex12> is the stable URL identity; azn_sk_<hex32> is the signing
 * secret (§6.1: rotation replaces the secret only; revocation issues a new
 * pair and therefore a new endpoint URL).
 */
export function generateKeyPair(): GeneratedKeyPair {
  const publicKey = `azn_pk_${randomBytes(12).toString("hex")}`;
  const secret = `azn_sk_${randomBytes(32).toString("hex")}`;
  return {
    publicKey,
    secret,
    secretHash: sha256Hex(secret),
    secretCiphertext: encryptSecret(secret),
  };
}

/** Rotation: new secret under the same public key (§6.1). */
export function generateSecret(): Omit<GeneratedKeyPair, "publicKey"> {
  const secret = `azn_sk_${randomBytes(32).toString("hex")}`;
  return {
    secret,
    secretHash: sha256Hex(secret),
    secretCiphertext: encryptSecret(secret),
  };
}
