import type { EventSummary } from "./api";

const ORIGIN_TTL_MS = 30 * 60_000;
const PUBLIC_LIST_CACHE_TTL_MS = ORIGIN_TTL_MS;
const PUBLIC_LIST_CACHE_LIMIT = 8;

export type EventListSnapshot = { items: EventSummary[]; total: number };

export type EventListOrigin = {
  eventId: string;
  href: string;
  scrollY: number;
  capturedAt: number;
  snapshotKey?: string;
};

let origin: EventListOrigin | null = null;
const publicListCache = new Map<string, { snapshot: EventListSnapshot; expiresAt: number }>();

function listKey(query: string, page: number): string {
  return JSON.stringify([query, page]);
}

function listKeyForHref(href: string): string | null {
  const safeHref = safeListHref(href);
  if (safeHref === null) return null;
  const parsed = new URL(safeHref, "https://eventbook.invalid");
  const query = parsed.searchParams.get("q") ?? "";
  const page = Math.max(1, Number.parseInt(parsed.searchParams.get("page") ?? "1", 10) || 1);
  return listKey(query, page);
}

export function getCachedPublicEventList(query: string, page: number): EventListSnapshot | null {
  const key = listKey(query, page);
  const entry = publicListCache.get(key);
  if (entry === undefined) return null;
  if (entry.expiresAt <= Date.now()) {
    publicListCache.delete(key);
    return null;
  }
  publicListCache.delete(key);
  publicListCache.set(key, entry);
  return entry.snapshot;
}

export function cachePublicEventList(query: string, page: number, snapshot: EventListSnapshot) {
  currentOrigin();
  const key = listKey(query, page);
  publicListCache.delete(key);
  publicListCache.set(key, { snapshot, expiresAt: Date.now() + PUBLIC_LIST_CACHE_TTL_MS });
  while (publicListCache.size > PUBLIC_LIST_CACHE_LIMIT) {
    const oldestKey = Array.from(publicListCache.keys()).find(
      (candidate) => candidate !== origin?.snapshotKey,
    );
    if (oldestKey === undefined) break;
    publicListCache.delete(oldestKey);
  }
}

export function getEventListSnapshotForOrigin(expected: EventListOrigin): EventListSnapshot | null {
  if (origin !== expected || expected.snapshotKey === undefined) return null;
  const entry = publicListCache.get(expected.snapshotKey);
  if (entry === undefined || entry.expiresAt <= Date.now()) {
    publicListCache.delete(expected.snapshotKey);
    return null;
  }
  return entry.snapshot;
}

export function invalidatePublicEventLists() {
  publicListCache.clear();
}

function safeListHref(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const parsed = new URL(href, "https://eventbook.invalid");
  if (parsed.origin !== "https://eventbook.invalid" || parsed.pathname !== "/") {
    return null;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function currentOrigin(): EventListOrigin | null {
  if (origin === null) return null;
  if (Date.now() - origin.capturedAt > ORIGIN_TTL_MS) {
    origin = null;
    return null;
  }
  return origin;
}

export function rememberEventListOrigin(
  eventId: string,
  href: string,
  scrollY: number,
  snapshot?: EventListSnapshot,
) {
  const safeHref = safeListHref(href);
  if (safeHref === null) return;
  const snapshotKey = snapshot === undefined ? null : listKeyForHref(safeHref);
  if (snapshot !== undefined && snapshotKey !== null) {
    const parsed = new URL(safeHref, "https://eventbook.invalid");
    const query = parsed.searchParams.get("q") ?? "";
    const page = Math.max(1, Number.parseInt(parsed.searchParams.get("page") ?? "1", 10) || 1);
    cachePublicEventList(query, page, snapshot);
  }
  origin = {
    eventId,
    href: safeHref,
    scrollY: Math.max(0, scrollY),
    capturedAt: Date.now(),
    ...(snapshotKey === null ? {} : { snapshotKey }),
  };
}

export function getEventListOriginForEvent(eventId: string): EventListOrigin | null {
  const current = currentOrigin();
  return current?.eventId === eventId ? current : null;
}

export function getEventListOriginForHref(href: string): EventListOrigin | null {
  const safeHref = safeListHref(href);
  const current = currentOrigin();
  return current !== null && safeHref === current.href ? current : null;
}

export function consumeEventListOrigin(expected: EventListOrigin) {
  if (origin === expected) origin = null;
}

export function clearEventListOrigin() {
  origin = null;
}

export function clearPublicEventListCache() {
  publicListCache.clear();
}
