"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ApiRequestError, api, type EventSummary } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatNepal, NEPAL_LABEL } from "../lib/datetime";
import { getCachedPublicEventDetail, loadPublicEventDetail, prefetchPublicEventDetail } from "../lib/public_event_cache";
import {
  cachePublicEventList,
  getCachedPublicEventList,
  getEventListOriginForHref,
  getEventListSnapshotForOrigin,
  consumeEventListOrigin,
  rememberEventListOrigin,
  type EventListOrigin,
} from "../lib/event_list_navigation";

const PAGE_SIZE = 10;
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function seatsLabel(event: EventSummary): string {
  if (event.seats_left <= 0) return "Full";
  if (event.seats_left === 1) return "1 seat left";
  return `${event.seats_left} seats left`;
}

export default function Home() {
  return (
    <Suspense fallback={<main><p className="empty-state" role="status">Loading events…</p></main>}>
      <Listing />
    </Suspense>
  );
}

function Listing() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, ready, expired, error: authError, markSessionExpired, clearError } = useAuth();

  const query = params.get("q") ?? "";
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const [draft, setDraft] = useState(query);
  const [items, setItems] = useState<EventSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [failureKey, setFailureKey] = useState<string | null>(null);
  const [state, setState] = useState<"pending" | "ready" | "error" | "empty">("pending");
  const [failure, setFailure] = useState<string | null>(null);
  const [openingEvent, setOpeningEvent] = useState<{ eventId: string; key: string } | null>(null);
  const [openingFailure, setOpeningFailure] = useState<{ eventId: string; key: string } | null>(null);
  const requestId = useRef(0);
  const navigationId = useRef(0);
  const activeNavigation = useRef<{ id: number; eventId: string; key: string; href: string } | null>(null);
  const restoringOrigin = useRef<EventListOrigin | null>(null);
  const restoredOrigin = useRef<string | null>(null);

  useEffect(() => setDraft(query), [query]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    const key = JSON.stringify([query, page]);
    setState("pending");
    setFailure(null);
    setFailureKey(null);
    try {
      const body = await api.listEvents(query, page, PAGE_SIZE);
      // Discard stale responses: only the latest query may render.
      if (requestId.current !== id) return;
      cachePublicEventList(query, page, { items: body.items, total: body.total });
      setItems(body.items);
      setTotal(body.total);
      setLoadedKey(key);
      setState(body.items.length === 0 ? "empty" : "ready");
    } catch (err: unknown) {
      if (requestId.current !== id) return;
      if (err instanceof ApiRequestError && err.status === 401) markSessionExpired();
      setState("error");
      setFailure(err instanceof ApiRequestError ? err.message : "Could not load events.");
      setFailureKey(key);
    }
  }, [query, page, markSessionExpired]);

  useEffect(() => {
    // Management-only admins work in /admin. Redirect only after session
    // restoration knows the role; redirecting earlier would bounce an
    // admin away on every reload before hydration finishes.
    if (!ready) return;
    if (user?.role === "admin") {
      router.replace("/admin");
      return;
    }
    void load();
  }, [ready, user, load, router]);

  const currentKey = JSON.stringify([query, page]);
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;
  const hasCurrentResults = loadedKey === currentKey;
  const currentItems = hasCurrentResults ? items : [];
  const currentTotal = hasCurrentResults ? total : 0;
  const listSnapshotRef = useRef<{ key: string; items: EventSummary[]; total: number } | null>(null);
  listSnapshotRef.current = hasCurrentResults
    ? { key: currentKey, items: currentItems, total: currentTotal }
    : null;

  useEffect(() => {
    const navigation = activeNavigation.current;
    if (navigation !== null && navigation.key !== currentKey) {
      activeNavigation.current = null;
      setOpeningEvent(null);
      setOpeningFailure(null);
    }
  }, [currentKey]);

  useEffect(() => () => {
    activeNavigation.current = null;
  }, []);

  function cancelEventNavigation() {
    activeNavigation.current = null;
    setOpeningEvent(null);
    setOpeningFailure(null);
  }

  function currentListHref() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  useBrowserLayoutEffect(() => {
    const href = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const origin = getEventListOriginForHref(href);
    const originSnapshot = origin === null ? null : getEventListSnapshotForOrigin(origin);
    restoringOrigin.current = originSnapshot === null ? null : origin;
    const snapshot = getCachedPublicEventList(query, page);
    setLoadedKey(currentKey);
    setFailure(null);
    setFailureKey(null);
    if (snapshot === null) {
      setItems([]);
      setTotal(0);
      setLoadedKey(null);
      setState("pending");
      return;
    }
    setItems(snapshot.items);
    setTotal(snapshot.total);
    setState("pending");
  }, [currentKey, page, query]);

  useBrowserLayoutEffect(() => {
    const origin = restoringOrigin.current;
    if (origin === null || !hasCurrentResults) return;
    const href = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (getEventListOriginForHref(href) !== origin || getEventListSnapshotForOrigin(origin) === null) return;
    const restoreKey = `${origin.eventId}:${origin.href}:${origin.capturedAt}`;
    if (restoredOrigin.current === restoreKey) return;

    const root = document.documentElement;
    const previousScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    void root.scrollHeight;
    window.scrollTo(0, origin.scrollY);
    root.style.scrollBehavior = previousScrollBehavior;
    restoredOrigin.current = restoreKey;
    consumeEventListOrigin(origin);
  }, [hasCurrentResults, currentKey]);

  function search(next: string) {
    cancelEventNavigation();
    const trimmed = next.trim();
    const target = trimmed === "" ? "/" : `/?q=${encodeURIComponent(trimmed)}`;
    setDraft(next);
    router.push(target);
  }

  function go(nextPage: number) {
    cancelEventNavigation();
    const search = new URLSearchParams();
    if (query !== "") search.set("q", query);
    if (nextPage > 1) search.set("page", String(nextPage));
    const suffix = search.toString();
    router.push(suffix === "" ? "/" : `/?${suffix}`);
  }

  function prefetchEvent(eventId: string) {
    prefetchPublicEventDetail(eventId);
  }

  function beginEventNavigation(eventId: string) {
    if (activeNavigation.current?.eventId === eventId && activeNavigation.current.key === currentKey) return;
    const navigation = { id: ++navigationId.current, eventId, key: currentKey, href: currentListHref() };
    activeNavigation.current = navigation;
    setOpeningEvent({ eventId, key: currentKey });
    setOpeningFailure(null);

    const navigate = () => {
      if (
        activeNavigation.current?.id !== navigation.id || currentKeyRef.current !== navigation.key ||
        currentListHref() !== navigation.href
      ) {
        if (activeNavigation.current?.id === navigation.id) cancelEventNavigation();
        return;
      }
      rememberEventListOrigin(
        eventId,
        currentListHref(),
        window.scrollY,
        listSnapshotRef.current?.key === navigation.key
          ? { items: listSnapshotRef.current.items, total: listSnapshotRef.current.total }
          : undefined,
      );
      activeNavigation.current = null;
      setOpeningEvent(null);
      router.push(`/events/${eventId}`);
    };

    if (getCachedPublicEventDetail(eventId) !== null) {
      navigate();
      return;
    }
    void loadPublicEventDetail(eventId).then(navigate).catch(() => {
      if (activeNavigation.current?.id !== navigation.id || currentKeyRef.current !== navigation.key) return;
      activeNavigation.current = null;
      setOpeningEvent(null);
      setOpeningFailure({ eventId, key: navigation.key });
    });
  }

  function handleEventLinkClick(eventId: string, click: MouseEvent<HTMLAnchorElement>) {
    const link = click.currentTarget;
    const target = link.getAttribute("target");
    if (
      click.defaultPrevented || click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey ||
      (target !== null && target !== "" && target !== "_self") || link.hasAttribute("download")
    ) return;
    click.preventDefault();
    beginEventNavigation(eventId);
  }

  function cancelForInPageDestination(click: MouseEvent<HTMLAnchorElement>) {
    if (click.defaultPrevented || click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    cancelEventNavigation();
  }

  const hasCurrentFailure = state === "error" && failureKey === currentKey;
  const isRefreshing = hasCurrentResults && state === "pending";
  const isLoading = !hasCurrentResults && !hasCurrentFailure;
  const pages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));

  return (
    <main className="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <h1 id="home-title">Find your next experience</h1>
        <p>Make room for something new. Discover upcoming events and find a seat for what moves you.</p>
        <a className="button button-primary" href="#events" onClick={cancelForInPageDestination}>Browse events</a>
      </section>
      {ready && expired && <p role="alert">Your session expired. Please log in again.</p>}
      {ready && authError !== null && (
        <p role="alert">
          {authError}{" "}
          <button type="button" onClick={clearError}>
            Dismiss
          </button>
        </p>
      )}

      <section id="events" className="event-listing" aria-labelledby="events-title">
        <div className="section-heading">
          <div>
            <h2 id="events-title">Upcoming events</h2>
            <p className="muted">Good things ahead. Find your place.</p>
          </div>
          <form className="search-form" role="search"
            onSubmit={(e) => {
              e.preventDefault();
              search(draft);
            }}
          >
            <input
              type="search"
              placeholder="Search events by title"
              aria-label="Search events by title"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />{" "}
            <button type="submit">Search</button>
          </form>
        </div>

        {isLoading && <p className="empty-state" role="status">Loading events…</p>}
        {isRefreshing && <p className="refresh-status" role="status">Updating events…</p>}
        {hasCurrentFailure && (
          <p role="alert">
            {failure}{" "}
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </p>
        )}
        {hasCurrentResults && currentItems.length === 0 && <p className="empty-state">No events found. Try a different search.</p>}
        {hasCurrentResults && currentItems.length > 0 && (
          <>
            <ul className="event-grid" aria-busy={isRefreshing}>
              {currentItems.map((event) => (
                <li key={event.id} className="card event-card">
                  <time className="event-date" dateTime={event.starts_at} title={NEPAL_LABEL}>{formatNepal(event.starts_at)}</time>
                  <h3>{event.title}</h3>
                  <p className="event-venue">{event.venue}</p>
                  <div className="event-card-footer">
                    <span className={`availability${!isRefreshing && event.seats_left <= 0 ? " availability-full" : ""}`}>
                      {isRefreshing ? "Updating availability…" : hasCurrentFailure ? "Availability unavailable" : seatsLabel(event)}
                    </span>
                    <Link
                      className={`button${openingEvent?.eventId === event.id && openingEvent.key === currentKey ? " event-link-opening" : ""}`}
                      href={`/events/${event.id}`}
                      aria-label={`View event: ${event.title}`}
                      aria-busy={openingEvent?.eventId === event.id && openingEvent.key === currentKey}
                      onMouseEnter={() => prefetchEvent(event.id)}
                      onFocus={() => prefetchEvent(event.id)}
                      onTouchStart={() => prefetchEvent(event.id)}
                      onClick={(click) => handleEventLinkClick(event.id, click)}
                    >
                      View event
                      {openingEvent?.eventId === event.id && openingEvent.key === currentKey && <span className="event-opening" role="status">Opening event…</span>}
                    </Link>
                    {openingFailure?.eventId === event.id && openingFailure.key === currentKey && (
                      <span className="event-opening-error" role="alert">
                        Could not open this event. <button type="button" aria-label={`Retry opening ${event.title}`} onClick={() => beginEventNavigation(event.id)}>Retry</button>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="pagination">
              <p className="muted">
                Page {page} of {pages} ({currentTotal} events)
              </p>
              <p className="button-row">
                <button type="button" disabled={page <= 1 || isRefreshing} onClick={() => go(page - 1)}>
                  Previous
                </button>{" "}
                <button
                  type="button"
                  disabled={page >= pages || isRefreshing}
                  onClick={() => go(page + 1)}
                >
                  Next
                </button>
              </p>
            </div>
          </>
        )}
        <p className="timezone-note">All times shown in {NEPAL_LABEL}.</p>
      </section>
    </main>
  );
}
