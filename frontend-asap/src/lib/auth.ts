// ─────────────────────────────────────────────────────────────
// Auth token storage for the ASAP backend (Bearer JWT).
// The backend authenticates via `Authorization: Bearer <accessToken>` (NOT cookies),
// so we keep the tokens in localStorage and MIRROR the access token into a readable
// cookie (`asap_access`) purely so the Next.js middleware route-guard can see it.
// ─────────────────────────────────────────────────────────────

const ACCESS_KEY = "asap_access";
const REFRESH_KEY = "asap_refresh";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  phone?: string | null;
  createdAt?: string;
}

const isBrowser = () => typeof window !== "undefined";

function readCookie(name: string): string | null {
  if (!isBrowser()) return null;
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name + "=([^;]*)"),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

export function getAccessToken(): string | null {
  if (!isBrowser()) return null;
  // localStorage is primary; fall back to the cookie (e.g. after a middleware refresh).
  return window.localStorage.getItem(ACCESS_KEY) ?? readCookie(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(REFRESH_KEY) ?? readCookie(REFRESH_KEY);
}

export function setTokens(tokens: Tokens): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(ACCESS_KEY, tokens.accessToken);
  window.localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  // Readable cookie (NOT httpOnly) so middleware.ts can gate protected routes.
  const maxAge = tokens.expiresIn ?? 60 * 60 * 24;
  document.cookie = `${ACCESS_KEY}=${tokens.accessToken}; path=/; max-age=${maxAge}; samesite=lax`;
  document.cookie = `${REFRESH_KEY}=${tokens.refreshToken}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
}

export function clearTokens(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(ACCESS_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
  document.cookie = `${ACCESS_KEY}=; path=/; max-age=0; samesite=lax`;
  document.cookie = `${REFRESH_KEY}=; path=/; max-age=0; samesite=lax`;
}

export function isAuthenticated(): boolean {
  return !!getAccessToken();
}

export function storeUser(user: AuthUser): void {
  if (!isBrowser()) return;
  window.localStorage.setItem("asap_user", JSON.stringify(user));
}

export function getStoredUser(): AuthUser | null {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem("asap_user");
  return raw ? (JSON.parse(raw) as AuthUser) : null;
}
