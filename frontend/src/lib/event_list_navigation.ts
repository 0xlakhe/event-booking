import type { EventSummary } from "./api";

const ORIGIN_TTL_MS = 30 * 60_000;

export type EventListSnapshot = { items: EventSummary[]; total: number };

export type EventListOrigin = {
  eventId: string;
  href: string;
  scrollY: number;
  capturedAt: number;
  snapshot?: EventListSnapshot;
};

let origin: EventListOrigin | null = null;

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
  origin = {
    eventId,
    href: safeHref,
    scrollY: Math.max(0, scrollY),
    capturedAt: Date.now(),
    ...(snapshot === undefined ? {} : { snapshot }),
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
