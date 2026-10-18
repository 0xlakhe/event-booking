import { api, type EventDetail } from "./api";

const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 20;
const MAX_PREFETCHES = 3;

type CachedEvent = { detail: EventDetail; expiresAt: number };
type Request = { promise: Promise<EventDetail>; invalidated: boolean; prefetch: boolean };

const cache = new Map<string, CachedEvent>();
const requests = new Map<string, Request>();
let activePrefetches = 0;

export function getCachedPublicEventDetail(eventId: string): EventDetail | null {
  const entry = cache.get(eventId);
  if (entry === undefined) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(eventId);
    return null;
  }
  cache.delete(eventId);
  cache.set(eventId, entry);
  return entry.detail;
}

function cacheDetail(eventId: string, detail: EventDetail) {
  cache.delete(eventId);
  cache.set(eventId, { detail, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_LIMIT) {
    const oldestId = cache.keys().next().value;
    if (oldestId === undefined) break;
    cache.delete(oldestId);
  }
}

function requestDetail(eventId: string, isPrefetch: boolean): Promise<EventDetail> {
  const current = requests.get(eventId);
  if (current !== undefined && !current.invalidated) return current.promise;

  if (isPrefetch) activePrefetches += 1;
  let request: Request | undefined;
  const promise = api.getEvent(eventId).then((detail) => {
    if (request !== undefined && requests.get(eventId) === request && !request.invalidated) {
      cacheDetail(eventId, detail);
    }
    return detail;
  }).finally(() => {
    if (request?.prefetch) activePrefetches -= 1;
    if (request !== undefined && requests.get(eventId) === request) requests.delete(eventId);
  });
  request = { promise, invalidated: false, prefetch: isPrefetch };
  requests.set(eventId, request);
  return promise;
}

export function loadPublicEventDetail(eventId: string): Promise<EventDetail> {
  const cached = getCachedPublicEventDetail(eventId);
  if (cached !== null) return Promise.resolve(cached);
  const pendingPrefetch = requests.get(eventId);
  if (pendingPrefetch?.prefetch) {
    pendingPrefetch.invalidated = true;
    requests.delete(eventId);
  }
  return requestDetail(eventId, false);
}

export function prefetchPublicEventDetail(eventId: string): void {
  if (getCachedPublicEventDetail(eventId) !== null || requests.has(eventId)) return;
  if (activePrefetches >= MAX_PREFETCHES) return;
  void requestDetail(eventId, true).catch(() => {});
}

export function invalidatePublicEventDetail(eventId: string) {
  cache.delete(eventId);
  const request = requests.get(eventId);
  if (request !== undefined) {
    request.invalidated = true;
    requests.delete(eventId);
  }
}
