import type { Collection, EventDetail, TimeFilter } from "./api";

/** Admin events list cache: keyed by session, query, time filter, and page.
 * Entries use the same short freshness window as the public lists, and admin
 * mutations invalidate the acting account's entries so a refreshed tab never
 * serves pre-mutation rows. */

const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 12;

type CachedAdminList = {
  sessionIdentity: string;
  body: Collection<EventDetail>;
  expiresAt: number;
};

const cache = new Map<string, CachedAdminList>();
let cacheRevision = 0;

function cacheKey(
  sessionIdentity: string,
  query: string,
  timeFilter: TimeFilter,
  page: number,
): string {
  return JSON.stringify([sessionIdentity, query, timeFilter, page]);
}

export function getCachedAdminEventList(
  sessionIdentity: string,
  query: string,
  timeFilter: TimeFilter,
  page: number,
): Collection<EventDetail> | null {
  const key = cacheKey(sessionIdentity, query, timeFilter, page);
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

export function cacheAdminEventList(
  sessionIdentity: string,
  query: string,
  timeFilter: TimeFilter,
  page: number,
  body: Collection<EventDetail>,
  revision = cacheRevision,
): boolean {
  if (revision !== cacheRevision) return false;
  const key = cacheKey(sessionIdentity, query, timeFilter, page);
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
  return true;
}

export function getAdminEventListCacheRevision(): number {
  return cacheRevision;
}

export function invalidateAdminEventLists(sessionIdentity: string) {
  cacheRevision += 1;
  for (const [key, entry] of Array.from(cache.entries())) {
    if (entry.sessionIdentity === sessionIdentity) cache.delete(key);
  }
}

export function clearAdminEventListCache() {
  cacheRevision += 1;
  cache.clear();
}
