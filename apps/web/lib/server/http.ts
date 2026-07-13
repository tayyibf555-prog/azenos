import { NextResponse } from "next/server";
import { UnauthorizedError } from "./org";

/** Uniform JSON error envelope for dashboard API routes: { error: string }. */
export function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

/**
 * Route-handler wrapper: maps UnauthorizedError → 401, Zod-ish input errors
 * are the route's job (400 with detail), everything else → generic 500 with
 * full detail logged server-side only (spec §15).
 */
export function withErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse | Response>,
): (...args: Args) => Promise<NextResponse | Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof UnauthorizedError) return jsonError(401, "unauthorized");
      console.error("[api] unhandled error:", err);
      return jsonError(500, "internal_error");
    }
  };
}
