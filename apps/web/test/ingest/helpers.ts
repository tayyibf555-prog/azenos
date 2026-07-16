import { randomUUID } from "node:crypto";
import {
  alertRules,
  bookings,
  clients,
  contacts,
  db,
  events,
  ingestRateCounters,
  insights,
  organizations,
  projectIntegrations,
  projectKeys,
  projects,
  users,
  webhookDeliveries,
} from "@azen/db";
import { encryptSecret, sha256Hex } from "@azen/db/keys";
import {
  SIGNATURE_HEADER,
  TOKEN_HEADER,
  signBody,
} from "@azen/events/signing";
import { eq, inArray } from "drizzle-orm";
import { POST as ingestPOST } from "../../app/api/ingest/[publicKey]/route";

// Force the Postgres rate-limit fallback regardless of local .env contents.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

export interface Harness {
  orgId: string;
  userId: string;
  clientId: string;
  projectId: string;
  projectName: string;
  keyId: string;
  publicKey: string;
  secret: string;
  authMode: "hmac" | "token";
}

export async function createHarness(
  opts: { authMode?: "hmac" | "token"; rateLimitPer10s?: number } = {},
): Promise<Harness> {
  const authMode = opts.authMode ?? "hmac";
  const orgId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const projectId = randomUUID();
  const keyId = randomUUID();
  const publicKey = `azn_pk_test_${randomUUID()}`;
  const secret = `azn_sk_test_${randomUUID().replaceAll("-", "")}`;
  const projectName = `Ingest Test ${orgId.slice(0, 8)}`;

  await db.insert(organizations).values({ id: orgId, name: projectName });
  await db.insert(users).values({
    id: userId,
    orgId,
    name: "Test Owner",
    email: `owner+${orgId.slice(0, 8)}@test.example`,
  });
  await db.insert(clients).values({
    id: clientId,
    orgId,
    name: "Test Client",
    status: "active",
  });
  await db.insert(projects).values({
    id: projectId,
    orgId,
    clientId,
    name: projectName,
    slug: `ingest-test-${randomUUID()}`,
    type: "ai_agent",
    stack: "custom_code",
    status: "live",
  });
  await db.insert(projectKeys).values({
    id: keyId,
    orgId,
    projectId,
    publicKey,
    secretHash: sha256Hex(secret),
    secretCiphertext: encryptSecret(secret),
    authMode,
    rateLimitPer10s: opts.rateLimitPer10s ?? 100,
    label: "ingest test key",
  });

  return {
    orgId,
    userId,
    clientId,
    projectId,
    projectName,
    keyId,
    publicKey,
    secret,
    authMode,
  };
}

/** Contract Ground Rules delete order (+ alert_rules created by these tests). */
export async function cleanupHarness(h: Harness): Promise<void> {
  const orgKeyIds = db
    .select({ id: projectKeys.id })
    .from(projectKeys)
    .where(eq(projectKeys.orgId, h.orgId));
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.orgId, h.orgId));
  await db.delete(events).where(eq(events.orgId, h.orgId));
  await db.delete(bookings).where(eq(bookings.orgId, h.orgId));
  await db.delete(insights).where(eq(insights.orgId, h.orgId));
  await db.delete(alertRules).where(eq(alertRules.orgId, h.orgId));
  await db
    .delete(ingestRateCounters)
    .where(inArray(ingestRateCounters.projectKeyId, orgKeyIds));
  await db.delete(projectKeys).where(eq(projectKeys.orgId, h.orgId));
  await db
    .delete(projectIntegrations)
    .where(eq(projectIntegrations.orgId, h.orgId));
  await db.delete(projects).where(eq(projects.orgId, h.orgId));
  await db.delete(contacts).where(eq(contacts.orgId, h.orgId));
  await db.delete(clients).where(eq(clients.orgId, h.orgId));
  await db.delete(users).where(eq(users.orgId, h.orgId));
  await db.delete(organizations).where(eq(organizations.id, h.orgId));
}

export function makeEvent(
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    occurred_at: new Date().toISOString(),
    idempotency_key: `t:${randomUUID()}`,
    data: {},
    ...extra,
  };
}

export interface SendOptions {
  auth?: "hmac" | "token" | "none";
  secretOverride?: string;
  timestampS?: number;
  token?: string;
  /** Send this exact string instead of JSON.stringify(payload). */
  rawBody?: string;
}

export async function sendIngest(
  h: Harness,
  payload: unknown,
  opts: SendOptions = {},
): Promise<Response> {
  const raw = opts.rawBody ?? JSON.stringify(payload);
  const headers = new Headers({ "content-type": "application/json" });
  const auth = opts.auth ?? h.authMode;
  if (auth === "hmac") {
    headers.set(
      SIGNATURE_HEADER,
      signBody(
        opts.secretOverride ?? h.secret,
        raw,
        opts.timestampS ?? Math.floor(Date.now() / 1000),
      ),
    );
  } else if (auth === "token") {
    headers.set(TOKEN_HEADER, opts.token ?? h.secret);
  }
  return ingestPOST(
    new Request(`http://test.local/api/ingest/${h.publicKey}`, {
      method: "POST",
      headers,
      body: raw,
    }),
    { params: Promise.resolve({ publicKey: h.publicKey }) },
  );
}

export async function readJson<T = Record<string, unknown>>(
  res: Response,
): Promise<T> {
  return (await res.json()) as T;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll for after-response reactions and other async effects. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor: condition not met");
    await sleep(opts.intervalMs ?? 100);
  }
}

/** Keep multi-request rate-limit tests inside one fixed 10s window. */
export async function ensureFreshRateWindow(): Promise<void> {
  const msIntoWindow = Date.now() % 10_000;
  if (msIntoWindow > 8_000) await sleep(10_000 - msIntoWindow + 100);
}
