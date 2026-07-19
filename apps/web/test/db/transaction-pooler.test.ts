import { isTransactionPoolerUrl } from "@azen/db";
import { describe, expect, it } from "vitest";

/**
 * The production runtime targets Supabase's transaction-mode pooler (port
 * 6543), where postgres-js prepared statements must be disabled — and ONLY
 * there (packages/db/src/client.ts keys `prepare` off this sniff; migrations
 * stay on the session pooler, drizzle.config.ts refuses 6543). Pin the port
 * detection both ways so neither side regresses silently.
 */
describe("isTransactionPoolerUrl", () => {
  it("flags the Supabase transaction pooler (port 6543)", () => {
    expect(
      isTransactionPoolerUrl(
        "postgresql://postgres.ref:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres",
      ),
    ).toBe(true);
  });

  it("keeps prepared statements for session/direct connections", () => {
    const sessionOrDirect = [
      // session pooler — the migration path (pnpm db:migrate)
      "postgresql://postgres.ref:pw@aws-0-eu-west-3.pooler.supabase.com:5432/postgres",
      // local dev DB (scripts/db-local.sh)
      "postgres://postgres:postgres@localhost:54329/azen_os",
      // no explicit port → Postgres default 5432
      "postgres://user:pw@db.example.com/azen_os",
    ];
    for (const url of sessionOrDirect) {
      expect(isTransactionPoolerUrl(url), url).toBe(false);
    }
  });

  it("fails safe (treats as pooler) when the URL cannot be parsed", () => {
    expect(isTransactionPoolerUrl("")).toBe(true);
  });
});
