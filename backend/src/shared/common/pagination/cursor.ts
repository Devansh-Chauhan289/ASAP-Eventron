/**
 * Keyset (cursor) pagination helpers (Section 8.3 — never OFFSET at scale).
 * A cursor encodes the (createdAt, id) of the last row, base64url-encoded.
 */
export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Page<T> {
  data: T[];
  pageInfo: PageInfo;
}

export interface CursorPayload {
  createdAt: string; // ISO
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as CursorPayload;
    if (typeof parsed.createdAt === 'string' && typeof parsed.id === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Builds a Page from a fetched batch of `limit + 1` rows. */
export function buildPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    pageInfo: {
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    },
  };
}
