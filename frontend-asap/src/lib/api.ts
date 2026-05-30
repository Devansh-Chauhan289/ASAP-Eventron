import { v4 as uuidv4 } from "uuid";
import type {
  ApiError,
  Paginated,
  TripResource,
} from "./types";

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

// POST routes that require an Idempotency-Key.
const IDEMPOTENT_PATTERNS = [
  /^\/trips\/[^/]+\/checkout$/,
  /^\/trips\/[^/]+\/confirm$/,
  /^\/trips\/[^/]+\/cancel$/,
  /^\/trips(\/.*)?$/,
  /^\/legs(\/.*)?$/,
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
  // Stable idempotency key — reused verbatim across retries of the SAME logical op.
  idempotencyKey?: string;
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined>;
  // Max automatic retries for retryable failures / 429s.
  maxRetries?: number;
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Random jitter so retries don't thundering-herd.
function jitter(base: number): number {
  return base + Math.floor(Math.random() * 400);
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Core fetch wrapper.
 * - Auth: the JWT lives in an httpOnly cookie attached by the browser via
 *   `credentials: "include"`; the Next.js middleware also forwards/refreshes it.
 * - Idempotency: a uuid v4 key is generated once per logical POST and REUSED
 *   on every retry so the server dedupes correctly.
 * - Retry: on 429 honor Retry-After (+jitter); on { retryable: true } envelope
 *   retry with the SAME key; on { retryable: false } surface immediately.
 */
export async function apiFetch<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const maxRetries = opts.maxRetries ?? 3;

  // Generate the idempotency key ONCE — stays constant across retries.
  const idempotencyKey =
    opts.idempotencyKey ??
    (needsIdempotencyKey(method, path) ? uuidv4() : undefined);

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    let res: Response;
    try {
      res = await fetch(buildUrl(path, opts.query), {
        method,
        headers,
        credentials: "include",
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (networkErr) {
      // Network-level failures are retryable.
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

    // 429 — honor Retry-After header with jitter, reuse same key.
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
      attempt += 1;
      await sleep(jitter(retryAfter * 1000));
      continue;
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      const env = (payload?.error ?? payload) as ApiError | undefined;
      const apiError: ApiError = {
        code: env?.code ?? "UNKNOWN",
        message: env?.message ?? `Request failed (${res.status})`,
        retryable: env?.retryable ?? false,
      };

      // retryable:true => retry with SAME idempotency key.
      if (apiError.retryable && attempt < maxRetries) {
        attempt += 1;
        await sleep(jitter(500 * attempt));
        continue;
      }
      // retryable:false => surface to user immediately.
      throw new ApiClientError(res.status, apiError);
    }

    return payload as T;
  }
}

// ── Typed endpoint helpers ────────────────────────────────────

export const api = {
  /** Cursor-paginated list. Pass pageInfo.nextCursor as `cursor` for next page. */
  listEvents(cursor?: string) {
    return apiFetch<Paginated<unknown>>("/events", {
      query: { cursor, limit: 12 },
    });
  },

  getTrip(tripId: string, signal?: AbortSignal) {
    return apiFetch<TripResource>(`/trips/${tripId}`, { signal });
  },

  /** Creates the Stripe PaymentIntent; returns { clientSecret }. */
  checkout(tripId: string, idempotencyKey?: string) {
    return apiFetch<{ clientSecret: string }>(`/trips/${tripId}/checkout`, {
      method: "POST",
      idempotencyKey,
    });
  },

  /** Kicks off async booking — server responds 202; poll/stream for terminal state. */
  confirm(tripId: string, idempotencyKey?: string) {
    return apiFetch<TripResource>(`/trips/${tripId}/confirm`, {
      method: "POST",
      idempotencyKey,
    });
  },

  cancel(tripId: string, idempotencyKey?: string) {
    return apiFetch<TripResource>(`/trips/${tripId}/cancel`, {
      method: "POST",
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
  let es: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const TERMINAL: TripResource["status"][] = [
    "CONFIRMED",
    "PARTIALLY_BOOKED",
    "PAYMENT_FAILED",
    "CANCELLED",
  ];

  const stop = () => {
    closed = true;
    es?.close();
    if (pollTimer) clearInterval(pollTimer);
  };

  // Primary: EventSource live stream.
  try {
    es = new EventSource(`${BASE_URL}/trips/${tripId}/events`, {
      withCredentials: true,
    });
    es.onmessage = (evt) => {
      try {
        const trip = JSON.parse(evt.data) as TripResource;
        onUpdate(trip);
        if (TERMINAL.includes(trip.status)) stop();
      } catch (e) {
        onError?.(e);
      }
    };
    es.onerror = (e) => {
      // Stream dropped — the polling fallback below keeps us alive.
      onError?.(e);
    };
  } catch (e) {
    onError?.(e);
  }

  // Fallback: poll every 3s regardless, in case SSE is unavailable.
  pollTimer = setInterval(async () => {
    if (closed) return;
    try {
      const trip = await api.getTrip(tripId);
      onUpdate(trip);
      if (TERMINAL.includes(trip.status)) stop();
    } catch (e) {
      onError?.(e);
    }
  }, 3000);

  return stop;
}