import { db, ingestRateCounters } from "@azen/db";
import { sql } from "drizzle-orm";

/**
 * Phase 7 §B feedback webhook limiter — the same fixed-window INCR pattern as
 * the ingest limiter (lib/server/ingest/rate-limit.ts), but a 60s window with
 * DUAL caps: 30/min per feedback key AND 10/min per source IP. Fails OPEN like
 * ingest (availability beats limiter precision on infra hiccups).
 *
 * Fallbacks when Upstash isn't configured (local/dev):
 *   - per-key  → the Postgres `ingest_rate_counters` table (the key is a real
 *     project_keys row, so the FK holds; the 60s bucket never collides with
 *     ingest's 10s buckets for the same id).
 *   - per-IP   → an in-process fixed-window map (an IP isn't a project_keys id,
 *     so it can't live in that table; Upstash is the multi-instance path).
 */

const WINDOW_MS = 60_000;
export const PER_KEY_LIMIT = 30;
export const PER_IP_LIMIT = 10;

export interface FeedbackRateResult {
  limited: boolean;
  /** Seconds until the current window ends — the Retry-After value. */
  retryAfterS: number;
}

interface MemBucket {
  windowStartMs: number;
  count: number;
}
const ipBuckets = new Map<string, MemBucket>();

export async function checkFeedbackRateLimit(
  projectKeyId: string,
  ip: string,
): Promise<FeedbackRateResult> {
  const nowMs = Date.now();
  const windowStartMs = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  const retryAfterS = Math.max(
    1,
    Math.ceil((windowStartMs + WINDOW_MS - nowMs) / 1000),
  );

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      const [keyCount, ipCount] = await Promise.all([
        upstashIncrement(url, token, `fb:key:${projectKeyId}`, windowStartMs),
        upstashIncrement(url, token, `fb:ip:${ip}`, windowStartMs),
      ]);
      return {
        limited: keyCount > PER_KEY_LIMIT || ipCount > PER_IP_LIMIT,
        retryAfterS,
      };
    } catch (err) {
      // An Upstash outage must NOT disable the abuse ceiling entirely (returning
      // 0 counts would leave the public endpoint with zero throttling). Degrade
      // to the local Postgres/in-memory limiter instead — still effective per
      // instance — rather than failing fully open.
      console.error(
        "[feedback] upstash rate limit unavailable, using local fallback:",
        err,
      );
    }
  }

  const keyCount = await postgresIncrement(projectKeyId, windowStartMs);
  const ipCount = memIncrement(ip, windowStartMs);
  return {
    limited: keyCount > PER_KEY_LIMIT || ipCount > PER_IP_LIMIT,
    retryAfterS,
  };
}

/**
 * INCR + EXPIRE in one pipeline round trip. THROWS on any failure so the caller
 * can degrade to the local limiter — returning a fake 0 here would disable the
 * cap entirely during an Upstash outage.
 */
async function upstashIncrement(
  url: string,
  token: string,
  bucket: string,
  windowStartMs: number,
): Promise<number> {
  const key = `${bucket}:${windowStartMs / 1000}`;
  const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify([
      ["INCR", key],
      ["EXPIRE", key, "120"],
    ]),
  });
  if (!res.ok) throw new Error(`upstash responded ${res.status}`);
  const out = (await res.json()) as { result?: unknown }[];
  const count = out[0]?.result;
  if (typeof count !== "number") throw new Error("upstash INCR shape");
  return count;
}

async function postgresIncrement(
  projectKeyId: string,
  windowStartMs: number,
): Promise<number> {
  const [row] = await db
    .insert(ingestRateCounters)
    .values({
      projectKeyId,
      windowStart: new Date(windowStartMs),
      count: 1,
    })
    .onConflictDoUpdate({
      target: [ingestRateCounters.projectKeyId, ingestRateCounters.windowStart],
      set: { count: sql`${ingestRateCounters.count} + 1` },
    })
    .returning({ count: ingestRateCounters.count });
  return row?.count ?? 1;
}

function memIncrement(ip: string, windowStartMs: number): number {
  const existing = ipBuckets.get(ip);
  if (!existing || existing.windowStartMs !== windowStartMs) {
    ipBuckets.set(ip, { windowStartMs, count: 1 });
    // opportunistic sweep of expired buckets so the map can't grow unbounded
    if (ipBuckets.size > 5_000) {
      for (const [k, v] of ipBuckets) {
        if (v.windowStartMs !== windowStartMs) ipBuckets.delete(k);
      }
    }
    return 1;
  }
  existing.count += 1;
  return existing.count;
}
