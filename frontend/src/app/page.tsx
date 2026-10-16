"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, api, type EventSummary } from "../lib/api";
import { useAuth } from "../lib/auth";

const PAGE_SIZE = 10;

function seatsLabel(event: EventSummary): string {
  if (event.seats_left <= 0) return "Full";
  if (event.seats_left === 1) return "1 seat left";
  return `${event.seats_left} seats left`;
}

export default function Home() {
  const { user, ready, expired, logout, markSessionExpired } = useAuth();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<EventSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"pending" | "ready" | "error" | "empty">("pending");
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async (q: string, p: number) => {
    setState("pending");
    setFailure(null);
    try {
      const body = await api.listEvents(q, p, PAGE_SIZE);
      setItems(body.items);
      setTotal(body.total);
      setState(body.items.length === 0 ? "empty" : "ready");
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.status === 401) markSessionExpired();
      setState("error");
      setFailure(err instanceof ApiRequestError ? err.message : "Could not load events.");
    }
  }, [markSessionExpired]);

  useEffect(() => {
    void load(submitted, page);
  }, [load, submitted, page]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main>
      <h1>EventBook</h1>
      <p className="muted">
        {ready && user !== null ? (
          <>
            Signed in as {user.email} ({user.role}).{" "}
            <button type="button" onClick={() => void logout()}>
              Log out
            </button>
          </>
        ) : (
          <>
            <Link href="/login">Log in</Link> or <Link href="/register">register</Link> to book seats.
          </>
        )}
      </p>
      {ready && expired && <p role="alert">Your session expired. Please log in again.</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSubmitted(query.trim());
        }}
      >
        <input
          type="search"
          placeholder="Search events by title"
          aria-label="Search events by title"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />{" "}
        <button type="submit">Search</button>
      </form>

      {state === "pending" && <p>Loading events…</p>}
      {state === "error" && (
        <p role="alert">
          {failure}{" "}
          <button type="button" onClick={() => void load(submitted, page)}>
            Retry
          </button>
        </p>
      )}
      {state === "empty" && <p>No events found. Try a different search.</p>}
      {(state === "ready" || items.length > 0) && (
        <>
          <ul>
            {items.map((event) => (
              <li key={event.id} className="card">
                <strong>{event.title}</strong>
                <br />
                <span className="muted">
                  {event.venue} · {event.seats_left} / {event.total_seats} seats ·{" "}
                  {seatsLabel(event)}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">
            Page {page} of {pages} ({total} events)
          </p>
          <p>
            <button
              type="button"
              disabled={page <= 1 || state === "pending"}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>{" "}
            <button
              type="button"
              disabled={page >= pages || state === "pending"}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </p>
        </>
      )}
    </main>
  );
}
