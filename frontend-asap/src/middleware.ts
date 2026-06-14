import { NextResponse, type NextRequest } from "next/server";

// Routes that require authentication.
const PROTECTED = ["/home", "/dashboard", "/checkout", "/trips", "/profile"];

// Explicitly public route prefixes.
const PUBLIC = ["/", "/events", "/auth", "/login", "/register"];

const ACCESS_COOKIE = "asap_access";
const REFRESH_COOKIE = "asap_refresh";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:1201/api/v1";

function isProtected(pathname: string): boolean {
  return PROTECTED.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function isPublic(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC.filter((p) => p !== "/").some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** Silently exchange the refresh token for a new token pair (backend contract). */
async function refreshAccess(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | { tokens?: { accessToken: string; refreshToken: string } }
      | null;
    return data?.tokens ?? null;
  } catch {
    return null;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public routes straight through (events detail is public).
  if (isPublic(pathname) && !isProtected(pathname)) {
    return NextResponse.next();
  }

  if (!isProtected(pathname)) {
    return NextResponse.next();
  }

  const access = req.cookies.get(ACCESS_COOKIE)?.value;
  if (access) {
    return NextResponse.next();
  }

  // No access token — try a silent refresh before bouncing to /login.
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
  if (refresh) {
    const newTokens = await refreshAccess(refresh);
    if (newTokens) {
      const res = NextResponse.next();
      // NOT httpOnly: the Bearer-auth API client reads this cookie to authorize requests.
      res.cookies.set(ACCESS_COOKIE, newTokens.accessToken, {
        httpOnly: false,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      });
      res.cookies.set(REFRESH_COOKIE, newTokens.refreshToken, {
        httpOnly: false,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      });
      return res;
    }
  }

  // Unauthenticated → redirect to /login with a return path.
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run on app routes only; skip Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};