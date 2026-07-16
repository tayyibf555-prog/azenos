import { randomUUID } from "node:crypto";
import {
  clients,
  db,
  events,
  feedbackItems,
  ingestRateCounters,
  organizations,
  projectKeys,
  projects,
  users,
  webhookDeliveries,
} from "@azen/db";
import { sha256Hex } from "@azen/db/keys";
import { eq, inArray } from "drizzle-orm";
import { POST as feedbackPOST } from "../../app/api/feedback/[publicKey]/route";

// Force the Postgres / in-memory rate-limit fallbacks regardless of .env.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
// Simulate sitting behind ONE trusted reverse proxy: the single X-Forwarded-For
// token each request carries is then the real client IP (clientIp reads it from
// the right). Without this the hardened clientIp ignores XFF entirely and every
// call would collide on "unknown", tripping the per-IP limiter across tests.
process.env.TRUSTED_PROXY_HOPS = "1";

export interface FeedbackHarness {
  orgId: string;
  userId: string;
  clientId: string;
  projectId: string;
  /** kind='feedback' public key (the widget key). */
  feedbackKeyId: string;
  feedbackPublicKey: string;
  /** kind='ingest' public key (for cross-privilege tests). */
  ingestKeyId: string;
  ingestPublicKey: string;
}

export async function createFeedbackHarness(): Promise<FeedbackHarness> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const projectId = randomUUID();
  const feedbackKeyId = randomUUID();
  const ingestKeyId = randomUUID();
  const feedbackPublicKey = `azn_fb_test_${randomUUID().replaceAll("-", "")}`;
  const ingestPublicKey = `azn_pk_test_${randomUUID().replaceAll("-", "")}`;
  const name = `Feedback Test ${orgId.slice(0, 8)}`;

  await db.insert(organizations).values({ id: orgId, name });
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
    name,
    slug: `feedback-test-${randomUUID()}`,
    type: "ai_agent",
    stack: "custom_code",
    status: "live",
  });
  await db.insert(projectKeys).values([
    {
      id: feedbackKeyId,
      orgId,
      projectId,
      publicKey: feedbackPublicKey,
      secretHash: sha256Hex(`feedback:${randomUUID()}`),
      authMode: "token",
      kind: "feedback",
      label: "feedback test key",
    },
    {
      id: ingestKeyId,
      orgId,
      projectId,
      publicKey: ingestPublicKey,
      secretHash: sha256Hex(`azn_sk_test_${randomUUID()}`),
      authMode: "hmac",
      kind: "ingest",
      label: "ingest test key",
    },
  ]);

  return {
    orgId,
    userId,
    clientId,
    projectId,
    feedbackKeyId,
    feedbackPublicKey,
    ingestKeyId,
    ingestPublicKey,
  };
}

export async function cleanupFeedbackHarness(h: FeedbackHarness): Promise<void> {
  const orgKeyIds = db
    .select({ id: projectKeys.id })
    .from(projectKeys)
    .where(eq(projectKeys.orgId, h.orgId));
  await db.delete(feedbackItems).where(eq(feedbackItems.orgId, h.orgId));
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.orgId, h.orgId));
  await db.delete(events).where(eq(events.orgId, h.orgId));
  await db
    .delete(ingestRateCounters)
    .where(inArray(ingestRateCounters.projectKeyId, orgKeyIds));
  await db.delete(projectKeys).where(eq(projectKeys.orgId, h.orgId));
  await db.delete(projects).where(eq(projects.orgId, h.orgId));
  await db.delete(clients).where(eq(clients.orgId, h.orgId));
  await db.delete(users).where(eq(users.orgId, h.orgId));
  await db.delete(organizations).where(eq(organizations.id, h.orgId));
}

export interface FeedbackBody {
  kind?: string;
  message?: string;
  severity?: number;
  submitter?: { name?: string; email?: string };
  page_url?: string;
  website?: string;
  [k: string]: unknown;
}

/** POST to the public feedback route. A unique IP per call avoids the
 *  in-memory per-IP limiter tripping across otherwise-independent tests. */
export async function sendFeedback(
  publicKey: string,
  body: FeedbackBody | string,
  opts: { ip?: string } = {},
): Promise<Response> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers = new Headers({
    "content-type": "application/json",
    "x-forwarded-for": opts.ip ?? randomIp(),
  });
  return feedbackPOST(
    new Request(`http://test.local/api/feedback/${publicKey}`, {
      method: "POST",
      headers,
      body: raw,
    }),
    { params: Promise.resolve({ publicKey }) },
  );
}

export function randomIp(): string {
  const oct = () => Math.floor(Math.random() * 254) + 1;
  return `${oct()}.${oct()}.${oct()}.${oct()}`;
}

export async function readJson<T = Record<string, unknown>>(
  res: Response,
): Promise<T> {
  return (await res.json()) as T;
}
