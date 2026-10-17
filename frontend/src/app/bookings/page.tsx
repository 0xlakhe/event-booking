"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, api, type Booking } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { hasStarted, useNow } from "../../lib/clock";
import { NEPAL_LABEL, formatNepal } from "../../lib/datetime";

const PAGE_SIZE = 10;

function cancelMessage(code: string, fallback: string): string {
  switch (code) {
    case "EVENT_STARTED":
      return "This event already started, so the booking can no longer be cancelled.";
    case "NOT_FOUND":
      return "This booking no longer exists.";
    case "ADMIN_BOOKING_FORBIDDEN":
      return "Booking actions are not available to administrators.";
    default:
      return fallback;
  }
}

export default function BookingsPage() {
  const { user, ready, getToken, markSessionExpired, error: authError, clearError } = useAuth();
  const now = useNow();
  const userId = user?.id ?? null;
  const isAdmin = user?.role === "admin";
  const [items, setItems] = useState<Booking[]>([]);
  // Account that fetched the rendered rows. Rendered rows are always
  // scoped to the signed-in account: switching accounts clears them
  // immediately and late responses from the old account are discarded.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"pending" | "ready" | "error" | "empty">("pending");
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    setItems([]);
    setLoadedFor(null);
    setPendingId(null);
    setPage(1);
  }, [userId]);

  const load = useCallback(
    async (keepFailure = false) => {
      const token = getToken();
      if (token === null) {
        // Signed out (or just signed out): never render another user's rows,
        // including late responses from pre-sign-out requests.
        requestId.current += 1;
        setItems([]);
        setLoadedFor(null);
        setFailure(null);
        setState("empty");
        return;
      }
      const id = ++requestId.current;
      const owner = userId;
      setState("pending");
      if (!keepFailure) setFailure(null);
      try {
        const body = await api.myBookings(token, page, PAGE_SIZE);
        if (requestId.current !== id || getToken() !== token) return;
        if (body.items.length === 0 && body.total > 0 && page > 1) {
          // The current page emptied under us (e.g. a cancellation on the
          // last page): step back instead of stranding the viewer.
          setPage(page - 1);
          return;
        }
        setItems(body.items);
        setTotal(body.total);
        setLoadedFor(owner);
        setState(body.items.length === 0 ? "empty" : "ready");
      } catch (err: unknown) {
        if (requestId.current !== id || getToken() !== token) return;
        if (err instanceof ApiRequestError && err.status === 401) {
          markSessionExpired();
          setItems([]);
          setLoadedFor(null);
          setState("empty");
          return;
        }
        setState("error");
        setFailure(err instanceof ApiRequestError ? err.message : "Could not load bookings.");
      }
    },
    [getToken, markSessionExpired, page, userId],
  );

  useEffect(() => {
    if (ready && !isAdmin) void load();
    else if (ready && isAdmin) setState("empty");
  }, [ready, load, isAdmin]);

  async function cancel(booking: Booking) {
    const token = getToken();
    if (token === null) return;
    if (pendingId !== null) return;
    setPendingId(booking.id);
    try {
      await api.cancelBooking(booking.id, token);
      // The account may have switched mid-flight: only the current
      // account's screen may refresh or show feedback. The new account's
      // own load (triggered by the switch) already covers its rows.
      if (getToken() !== token) return;
      await load();
    } catch (err: unknown) {
      // A stale account's outcome is irrelevant once switched — in
      // particular its 401 must never expire the new session.
      if (getToken() !== token) return;
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        return;
      }
      if (err instanceof ApiRequestError) {
        // Refresh first so the message describes current state, then
        // restore the feedback the refresh would otherwise clear.
        // Re-check after the await: a switch mid-refetch leaves the
        // message to the new account's own flows.
        await load(true);
        if (getToken() !== token) return;
        setFailure(cancelMessage(err.code, err.message));
        return;
      }
      setFailure("Cancellation failed with a network error. Check your bookings before retrying.");
    } finally {
      // Clear only our own indicator; another account may have started
      // an action of its own while this request was in flight.
      setPendingId((current) => (current === booking.id ? null : current));
    }
  }

  const visible = loadedFor === userId ? items : [];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main>
      <h1>My bookings</h1>
      {ready && authError !== null && (
        <p role="alert">
          {authError}{" "}
          <button type="button" onClick={clearError}>
            Dismiss
          </button>
        </p>
      )}
      {ready && user === null && (
        <p>
          <Link href="/login">Log in</Link> to see your bookings.
        </p>
      )}
      {ready && user?.role === "admin" && (
        <p className="muted">
          Booking history is not available to administrators. Manage events from the{" "}
          <Link href="/admin">admin panel</Link>.
        </p>
      )}
      {state === "pending" && <p>Loading bookings…</p>}
      {state === "error" && (
        <p role="alert">
          {failure}{" "}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      {state === "empty" && !isAdmin && user !== null && visible.length === 0 && total === 0 && (
        <p>No bookings yet. Browse events to book a seat.</p>
      )}
      {visible.length > 0 && (
        <>
          <ul>
            {visible.map((booking) => {
              const cancelled = booking.cancelled_at !== null;
              const started = hasStarted(booking.event.starts_at, now);
              return (
                <li key={booking.id} className="card">
                  <Link href={`/events/${booking.event.id}`}>
                    <strong>{booking.event.title}</strong>
                  </Link>
                  <br />
                  <span className="muted">
                    <span title={NEPAL_LABEL}>{formatNepal(booking.event.starts_at)}</span>
                    {cancelled ? " · Cancelled" : ` · ${booking.event.seats_left} seats left`}
                  </span>
                  {!cancelled && (
                    <p>
                      <button
                        type="button"
                        disabled={pendingId !== null || started}
                        onClick={() => void cancel(booking)}
                      >
                        {pendingId === booking.id ? "Cancelling…" : "Cancel booking"}
                      </button>
                      {started && (
                        <span className="muted">
                          {" "}This event has already started; it can no longer be cancelled.
                        </span>
                      )}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="muted">
            Page {page} of {pages} ({total} bookings)
          </p>
          {pages > 1 && (
            <p>
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>{" "}
              <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </p>
          )}
        </>
      )}
      {visible.length === 0 && pages > 1 && (
        <p>
          <button type="button" onClick={() => setPage(1)}>
            Back to first page
          </button>
        </p>
      )}
      {failure !== null && state !== "error" && <p role="alert">{failure}</p>}
      <p>
        <Link href="/">Back to events</Link>
      </p>
    </main>
  );
}
