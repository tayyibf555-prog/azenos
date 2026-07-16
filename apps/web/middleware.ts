import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  // Public client share links (§P8-REPORT): logged-out, READ-ONLY, and never
  // indexed. Skip the auth wall entirely and stamp X-Robots-Tag so the page is
  // unreachable to crawlers regardless of auth mode.
  if (request.nextUrl.pathname.startsWith("/share/")) {
    const res = NextResponse.next();
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    return res;
  }

  // Local demo mode: no hosted Supabase project yet → no auth wall (§15 note:
  // v1 enforcement is app-layer; this activates the moment env vars exist)
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: {
            name: string;
            value: string;
            options?: Record<string, unknown>;
          }[],
        ) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLogin = request.nextUrl.pathname.startsWith("/login");
  if (!user && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (user && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
