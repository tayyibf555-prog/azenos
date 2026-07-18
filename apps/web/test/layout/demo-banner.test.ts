import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDemoMode } from "../../lib/supabase";

/**
 * The amber "local demo mode" banner (AppFrame's `demo` prop, wired in
 * app/layout.tsx via localDemoMode()) must only appear on a TRUE local demo.
 * On the live deployment DATABASE_URL is set and Supabase auth is intentionally
 * off (edge-protected, solo owner), so the banner would be misleading. Three
 * states, one honest banner — this locks the semantics.
 */
describe("localDemoMode — demo banner visibility", () => {
  const saved = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    // Restore so env never leaks into sibling suites (fileParallelism: false).
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("TRUE LOCAL DEMO: auth unconfigured AND no DATABASE_URL → banner shows", () => {
    expect(localDemoMode()).toBe(true);
  });

  it("LIVE-NO-AUTH: DATABASE_URL present, auth unconfigured → no banner", () => {
    process.env.DATABASE_URL = "postgres://user@host:5432/azen";
    expect(localDemoMode()).toBe(false);
  });

  it("AUTH CONFIGURED: Supabase env set → no banner, with or without DATABASE_URL", () => {
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    expect(localDemoMode()).toBe(false);
    process.env.DATABASE_URL = "postgres://user@host:5432/azen";
    expect(localDemoMode()).toBe(false);
  });
});
