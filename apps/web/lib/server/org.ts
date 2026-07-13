import { DEMO_ORG_ID, db, schema } from "@azen/db";
import { eq } from "drizzle-orm";
import { getSessionUser, supabaseConfigured } from "../supabase";

/**
 * Resolve the org for the current request. Server-side only.
 *
 * Two modes (spec §15 "RLS reality check" — app-level auth is the v1
 * enforcement layer):
 *  - Hosted Supabase configured → authenticated user's org, 401 otherwise.
 *  - Local demo mode → the seeded demo org.
 *
 * API routes: wrap in try/catch and map UnauthorizedError to a 401 JSON
 * response (see lib/server/http.ts helpers).
 */

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export async function requireOrgId(): Promise<string> {
  if (!supabaseConfigured()) return DEMO_ORG_ID;

  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();

  const row = await db.query.users.findFirst({
    where: eq(schema.users.id, user.id),
    columns: { orgId: true },
  });
  if (!row) throw new UnauthorizedError();
  return row.orgId;
}
