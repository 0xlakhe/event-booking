import type { Booking, Collection } from "./api";

const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 8;

type CachedBookings = {
  sessionIdentity: string;
  body: Collection<Booking>;
  expiresAt: number;
};

const cache = new Map<string, CachedBookings>();

function cacheKey(sessionIdentity: string, page: number): string {
  return JSON.stringify([sessionIdentity, page]);
}

export function getCachedOwnBookings(
  sessionIdentity: string,
  page: number,
): Collection<Booking> | null {
  const key = cacheKey(sessionIdentity, page);
  const entry = cache.get(key);
  if (entry === undefined) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.body;
}

export function cacheOwnBookings(
  sessionIdentity: string,
  page: number,
  body: Collection<Booking>,
) {
  const key = cacheKey(sessionIdentity, page);
  cache.delete(key);
  cache.set(key, {
    sessionIdentity,
    body,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  while (cache.size > CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function invalidateOwnBookings(sessionIdentity: string) {
  for (const [key, entry] of Array.from(cache.entries())) {
    if (entry.sessionIdentity === sessionIdentity) cache.delete(key);
  }
}

export function clearOwnBookingsCache() {
  cache.clear();
}
