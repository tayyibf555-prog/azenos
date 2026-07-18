import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase auth wiring. Until the hosted Supabase project exists (owner
 * to-do), SUPABASE_URL is unset and the app runs in local demo mode with a
 * visible banner instead of a login wall.
 */

export function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

/**
 * The amber "local demo mode" banner is only honest on a true local demo:
 * Supabase auth unconfigured AND no database wired up. On the live deployment
 * DATABASE_URL is set and auth is intentionally off (edge-protected, solo
 * owner), so the banner would be misleading — show the normal chrome instead.
 * This gates banner visibility ONLY; it does not touch the demo-auth path,
 * which still keys off supabaseConfigured().
 */
export function localDemoMode(): boolean {
  return !supabaseConfigured() && !process.env.DATABASE_URL;
}

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: {
            name: string;
            value: string;
            options?: Record<string, unknown>;
          }[],
        ) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // called from a Server Component — middleware refreshes sessions
          }
        },
      },
    },
  );
}

export async function getSessionUser() {
  if (!supabaseConfigured()) return null;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
