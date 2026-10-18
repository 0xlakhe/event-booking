import type { Booking, Collection } from "./api";

const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 8;
const MEMBERSHIP_CACHE_LIMIT = 32;

type CachedBookings = {
  sessionIdentity: string;
  body: Collection<Booking>;
  expiresAt: number;
};

const cache = new Map<string, CachedBookings>();
type CachedMembership = {
  sessionIdentity: string;
  eventId: string;
  isBooked: boolean;
  expiresAt: number;
};
const membershipCache = new Map<string, CachedMembership>();
let cacheRevision = 0;

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
  revision = cacheRevision,
): boolean {
  if (revision !== cacheRevision) return false;
  const key = cacheKey(sessionIdentity, page);
  cache.delete(key);
  cache.set(key, {
    sessionIdentity,
    body,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  for (const booking of body.items) {
    cacheOwnBookingMembership(sessionIdentity, booking.event.id, true, revision);
  }
  while (cache.size > CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return true;
}

export function getOwnBookingsCacheRevision(): number {
  return cacheRevision;
}

function membershipKey(sessionIdentity: string, eventId: string): string {
  return JSON.stringify([sessionIdentity, eventId]);
}

export function getCachedOwnBookingMembership(
  sessionIdentity: string,
  eventId: string,
): boolean | null {
  const key = membershipKey(sessionIdentity, eventId);
  const entry = membershipCache.get(key);
  if (entry === undefined) return null;
  if (entry.expiresAt <= Date.now()) {
    membershipCache.delete(key);
    return null;
  }
  membershipCache.delete(key);
  membershipCache.set(key, entry);
  return entry.isBooked;
}

export function cacheOwnBookingMembership(
  sessionIdentity: string,
  eventId: string,
  isBooked: boolean,
  revision = cacheRevision,
): boolean {
  if (revision !== cacheRevision) return false;
  const key = membershipKey(sessionIdentity, eventId);
  membershipCache.delete(key);
  membershipCache.set(key, {
    sessionIdentity,
    eventId,
    isBooked,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  while (membershipCache.size > MEMBERSHIP_CACHE_LIMIT) {
    const oldestKey = membershipCache.keys().next().value;
    if (oldestKey === undefined) break;
    membershipCache.delete(oldestKey);
  }
  return true;
}

export function invalidateOwnBookings(sessionIdentity: string) {
  cacheRevision += 1;
  for (const [key, entry] of Array.from(cache.entries())) {
    if (entry.sessionIdentity === sessionIdentity) cache.delete(key);
  }
  for (const [key, entry] of Array.from(membershipCache.entries())) {
    if (entry.sessionIdentity === sessionIdentity) membershipCache.delete(key);
  }
}

export function clearOwnBookingsCache() {
  cacheRevision += 1;
  cache.clear();
  membershipCache.clear();
}
