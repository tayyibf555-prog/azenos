import { db, ingestRateCounters } from "@azen/db";
import { lt, sql } from "drizzle-orm";

/**
 * §6.3 step 2 rate limit: fixed 10s window per project key. Upstash REST when
 * configured (plain fetch, no SDK), else the Postgres counters fallback.
 */

const WINDOW_MS = 10_000;

export interface RateLimitResult {
  limited: boolean;
  /** Seconds until the current window ends — the Retry-After value. */
  retryAfterS: number;
  /** True when the Postgres fallback was used (drives stale-window cleanup). */
  usedPostgres: boolean;
}

export async function checkRateLimit(
  projectKeyId: string,
  limit: number,
): Promise<RateLimitResult> {
  const nowMs = Date.now();
  const windowStartMs = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  const retryAfterS = Math.max(
    1,
    Math.ceil((windowStartMs + WINDOW_MS - nowMs) / 1000),
  );

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const count = await upstashIncrement(url, token, projectKeyId, windowStartMs);
    return { limited: count > limit, retryAfterS, usedPostgres: false };
  }
  const count = await postgresIncrement(projectKeyId, windowStartMs);
  return { limited: count > limit, retryAfterS, usedPostgres: true };
}

/**
 * INCR + EXPIRE in one pipeline round trip. Fails OPEN (count 0) on Redis
 * trouble — ingest availability beats limiter precision (§6.3: never drop
 * data because infra hiccuped); the error is logged for ops.
 */
async function upstashIncrement(
  url: string,
  token: string,
  projectKeyId: string,
  windowStartMs: number,
): Promise<number> {
  const key = `ingest:rl:${projectKeyId}:${windowStartMs / 1000}`;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, "30"],
      ]),
    });
    if (!res.ok) throw new Error(`upstash responded ${res.status}`);
    const out = (await res.json()) as { result?: unknown }[];
    const count = out[0]?.result;
    if (typeof count !== "number") throw new Error("upstash INCR shape");
    return count;
  } catch (err) {
    console.error("[ingest] upstash rate limit failed open:", err);
    return 0;
  }
}

/** The contract's atomic upsert on ingest_rate_counters. */
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

/** Opportunistic cleanup — runs after the response, never on the hot path. */
export async function cleanupStaleWindows(): Promise<void> {
  await db
    .delete(ingestRateCounters)
    .where(lt(ingestRateCounters.windowStart, new Date(Date.now() - 60_000)));
}
