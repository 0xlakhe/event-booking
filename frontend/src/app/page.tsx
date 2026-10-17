"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, api, type EventSummary } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatNepal, NEPAL_LABEL } from "../lib/datetime";

const PAGE_SIZE = 10;

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
  const [state, setState] = useState<"pending" | "ready" | "error" | "empty">("pending");
  const [failure, setFailure] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => setDraft(query), [query]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setState("pending");
    setFailure(null);
    try {
      const body = await api.listEvents(query, page, PAGE_SIZE);
      // Discard stale responses: only the latest query may render.
      if (requestId.current !== id) return;
      setItems(body.items);
      setTotal(body.total);
      setState(body.items.length === 0 ? "empty" : "ready");
    } catch (err: unknown) {
      if (requestId.current !== id) return;
      if (err instanceof ApiRequestError && err.status === 401) markSessionExpired();
      setState("error");
      setFailure(err instanceof ApiRequestError ? err.message : "Could not load events.");
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

  function search(next: string) {
    const trimmed = next.trim();
    const target = trimmed === "" ? "/" : `/?q=${encodeURIComponent(trimmed)}`;
    setDraft(next);
    router.push(target);
  }

  function go(nextPage: number) {
    const search = new URLSearchParams();
    if (query !== "") search.set("q", query);
    if (nextPage > 1) search.set("page", String(nextPage));
    const suffix = search.toString();
    router.push(suffix === "" ? "/" : `/?${suffix}`);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <h1 id="home-title">Find your next experience</h1>
        <p>Make room for something new. Discover upcoming events and find a seat for what moves you.</p>
        <a className="button button-primary" href="#events">Browse events</a>
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

        {state === "pending" && <p className="empty-state" role="status">Loading events…</p>}
        {state === "error" && (
          <p role="alert">
            {failure}{" "}
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </p>
        )}
        {state === "empty" && <p className="empty-state">No events found. Try a different search.</p>}
        {(state === "ready" || items.length > 0) && (
          <>
            <ul className="event-grid">
              {items.map((event) => (
                <li key={event.id} className="card event-card">
                  <time className="event-date" dateTime={event.starts_at} title={NEPAL_LABEL}>{formatNepal(event.starts_at)}</time>
                  <h3>{event.title}</h3>
                  <p className="event-venue">{event.venue}</p>
                  <div className="event-card-footer">
                    <span className={`availability${event.seats_left <= 0 ? " availability-full" : ""}`}>{seatsLabel(event)}</span>
                    <Link className="button" href={`/events/${event.id}`} aria-label={`View event: ${event.title}`}>View event</Link>
                  </div>
                </li>
              ))}
            </ul>
            <div className="pagination">
              <p className="muted">
                Page {page} of {pages} ({total} events)
              </p>
              <p className="button-row">
                <button type="button" disabled={page <= 1 || state === "pending"} onClick={() => go(page - 1)}>
                  Previous
                </button>{" "}
                <button
                  type="button"
                  disabled={page >= pages || state === "pending"}
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
