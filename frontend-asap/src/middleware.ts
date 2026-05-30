import { NextResponse, type NextRequest } from "next/server";

// Routes that require authentication.
const PROTECTED = ["/home", "/dashboard", "/checkout", "/trips", "/profile"];

// Explicitly public route prefixes.
const PUBLIC = ["/", "/events", "/auth", "/login"];

const ACCESS_COOKIE = "asap_access";
const REFRESH_COOKIE = "asap_refresh";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

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

/** Silently exchange the refresh token for a new access token. */
async function refreshAccess(
  refreshToken: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${REFRESH_COOKIE}=${refreshToken}`,
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | { accessToken?: string }
      | null;
    return data?.accessToken ?? null;
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
    const newAccess = await refreshAccess(refresh);
    if (newAccess) {
      const res = NextResponse.next();
      res.cookies.set(ACCESS_COOKIE, newAccess, {
        httpOnly: true,
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