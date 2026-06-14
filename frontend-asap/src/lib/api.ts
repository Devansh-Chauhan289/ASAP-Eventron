import { v4 as uuidv4 } from "uuid";
import type { ApiError, Paginated, TripResource } from "./types";
import {
  AuthUser,
  Tokens,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setTokens,
  storeUser,
} from "./auth";

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:1201/api/v1";

// POST routes that require an Idempotency-Key (mirrors the backend @Idempotent() routes).
const IDEMPOTENT_PATTERNS = [
  /^\/trips\/[^/]+\/checkout$/,
  /^\/trips\/[^/]+\/confirm$/,
  /^\/trips\/[^/]+\/cancel$/,
  /^\/trips\/[^/]+\/legs/,
  /^\/trips$/,
];

function needsIdempotencyKey(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  return IDEMPOTENT_PATTERNS.some((re) => re.test(path));
}

/** Error thrown by the client carrying the parsed standard error envelope. */
export class ApiClientError extends Error {
  code: string;
  retryable: boolean;
  status: number;

  constructor(status: number, err: ApiError) {
    super(err.message);
    this.name = "ApiClientError";
    this.code = err.code;
    this.retryable = err.retryable;
    this.status = status;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined>;
  maxRetries?: number;
  // internal: set true after we've already tried a token refresh, to avoid loops
  _authRetried?: boolean;
  // skip attaching the Authorization header (auth endpoints)
  _noAuth?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.floor(Math.random() * 400);

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** Exchange the refresh token for a fresh token pair. Returns true on success. */
async function refreshTokens(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(buildUrl("/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as
      | { tokens?: Tokens }
      | null;
    if (!data?.tokens?.accessToken) return false;
    setTokens(data.tokens);
    return true;
  } catch {
    return false;
  }
}

/**
 * Core fetch wrapper.
 * - Auth: attaches `Authorization: Bearer <accessToken>` from local storage.
 * - On 401: transparently refreshes the token ONCE and retries.
 * - Idempotency: a uuid v4 key generated once per logical POST, REUSED on retry.
 * - Retry: 429 honors Retry-After (+jitter); `{ retryable:true }` retries with same key.
 */
export async function apiFetch<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const maxRetries = opts.maxRetries ?? 3;

  const idempotencyKey =
    opts.idempotencyKey ??
    (needsIdempotencyKey(method, path) ? uuidv4() : undefined);

  let attempt = 0;
  while (true) {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (!opts._noAuth) {
      const token = getAccessToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }

    let res: Response;
    try {
      res = await fetch(buildUrl(path, opts.query), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (networkErr) {
      if (attempt < maxRetries) {
        attempt += 1;
        await sleep(jitter(500 * attempt));
        continue;
      }
      throw new ApiClientError(0, {
        code: "NETWORK_ERROR",
        message:
          networkErr instanceof Error
            ? networkErr.message
            : "Network request failed",
        retryable: true,
      });
    }

    // 401 — try a single transparent token refresh, then replay once.
    if (res.status === 401 && !opts._authRetried && !opts._noAuth) {
      const ok = await refreshTokens();
      if (ok) {
        return apiFetch<T>(path, { ...opts, _authRetried: true, idempotencyKey });
      }
      clearTokens();
    }

    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
      attempt += 1;
      await sleep(jitter(retryAfter * 1000));
      continue;
    }

    if (res.status === 204) return undefined as T;

    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      const env = (payload?.error ?? payload) as ApiError | undefined;
      const apiError: ApiError = {
        code: env?.code ?? "UNKNOWN",
        message: env?.message ?? `Request failed (${res.status})`,
        retryable: env?.retryable ?? false,
      };
      if (apiError.retryable && attempt < maxRetries) {
        attempt += 1;
        await sleep(jitter(500 * attempt));
        continue;
      }
      throw new ApiClientError(res.status, apiError);
    }

    return payload as T;
  }
}

// ── Auth ──────────────────────────────────────────────────────
interface AuthResponse {
  user: AuthUser;
  tokens: Tokens;
}

export const auth = {
  async register(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<AuthResponse> {
    const res = await apiFetch<AuthResponse>("/auth/register", {
      method: "POST",
      body: input,
      _noAuth: true,
    });
    setTokens(res.tokens);
    storeUser(res.user);
    return res;
  },

  async login(input: {
    email: string;
    password: string;
  }): Promise<AuthResponse> {
    const res = await apiFetch<AuthResponse>("/auth/login", {
      method: "POST",
      body: input,
      _noAuth: true,
    });
    setTokens(res.tokens);
    storeUser(res.user);
    return res;
  },

  async logout(): Promise<void> {
    const refreshToken = getRefreshToken();
    try {
      if (refreshToken) {
        await apiFetch<void>("/auth/logout", {
          method: "POST",
          body: { refreshToken },
          _noAuth: true,
        });
      }
    } finally {
      clearTokens();
    }
  },

  me() {
    return apiFetch<AuthUser>("/me");
  },
};

// ── Typed endpoint helpers ────────────────────────────────────
export const api = {
  /** Real event search backed by the provider ACL (Ticketmaster). */
  searchEvents(params: {
    q?: string;
    city?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  }) {
    return apiFetch<Paginated<unknown>>("/events/search", { query: params });
  },

  getEvent(externalId: string) {
    return apiFetch<unknown>(`/events/${encodeURIComponent(externalId)}`);
  },

  recommendTrip(eventId: string) {
    return apiFetch<unknown>("/recommendations/trip", { query: { eventId } });
  },

  listTrips(cursor?: string) {
    return apiFetch<Paginated<TripResource>>("/trips", {
      query: { cursor, limit: 20 },
    });
  },

  createTrip(input: {
    anchor: { eventId: string; ticketTier: string; quantity: number };
  }) {
    return apiFetch<TripResource>("/trips", { method: "POST", body: input });
  },

  getTrip(tripId: string, signal?: AbortSignal) {
    return apiFetch<TripResource>(`/trips/${tripId}`, { signal });
  },

  quote(tripId: string) {
    return apiFetch<{ total: { amount: number; currency: string } }>(
      `/trips/${tripId}/quote`,
      { method: "POST" },
    );
  },

  /**
   * Creates the Stripe PaymentIntent. Backend returns `stripeClientSecret`; we also expose
   * `clientSecret` as an alias for existing consumers.
   */
  async checkout(tripId: string, idempotencyKey?: string) {
    const res = await apiFetch<{
      paymentIntentId: string;
      stripeClientSecret: string;
      amount: { amount: number; currency: string };
      status: string;
    }>(`/trips/${tripId}/checkout`, { method: "POST", body: {}, idempotencyKey });
    return { ...res, clientSecret: res.stripeClientSecret };
  },

  /**
   * Kicks off async booking — server responds 202; poll for terminal state.
   * `paymentIntentId` is required by the backend; when omitted (legacy demo callers) the
   * request fails fast and the UI falls back to its demo path.
   */
  confirm(tripId: string, paymentIntentId?: string, idempotencyKey?: string) {
    return apiFetch<TripResource>(`/trips/${tripId}/confirm`, {
      method: "POST",
      body: paymentIntentId ? { paymentIntentId } : {},
      idempotencyKey,
    });
  },

  cancel(tripId: string, idempotencyKey?: string) {
    return apiFetch<TripResource>(`/trips/${tripId}/cancel`, {
      method: "POST",
      body: {},
      idempotencyKey,
    });
  },
};

/**
 * Subscribe to live trip booking updates via SSE, falling back to 3s polling.
 * Returns an unsubscribe function. `onUpdate` fires with each TripResource.
 */
export function subscribeTripUpdates(
  tripId: string,
  onUpdate: (trip: TripResource) => void,
  onError?: (err: unknown) => void,
): () => void {
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const TERMINAL = [
    "CONFIRMED",
    "PARTIALLY_BOOKED",
    "PAYMENT_FAILED",
    "CANCELLED",
  ];

  const stop = () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
  };

  // Poll every 2.5s (EventSource can't send the Authorization header, so polling is the
  // reliable path for a Bearer-auth API; the backend SSE remains available for cookie auth).
  pollTimer = setInterval(async () => {
    if (closed) return;
    try {
      const trip = await api.getTrip(tripId);
      onUpdate(trip);
      if (TERMINAL.includes(trip.status)) stop();
    } catch (e) {
      onError?.(e);
    }
  }, 2500);

  return stop;
}
