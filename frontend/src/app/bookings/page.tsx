"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, api, type Booking } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { hasStarted, useNow } from "../../lib/clock";
import { NEPAL_LABEL, formatNepal } from "../../lib/datetime";
import { invalidatePublicEventDetail } from "../../lib/public_event_cache";
import {
  cacheOwnBookings,
  getCachedOwnBookings,
  getOwnBookingsCacheRevision,
  invalidateOwnBookings,
} from "../../lib/own_bookings_cache";
import { invalidatePublicEventLists } from "../../lib/event_list_navigation";

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
  const { user, ready, getToken, markSessionExpired, error: authError, clearError, sessionIdentity } = useAuth();
  const now = useNow();
  const userId = user?.id ?? null;
  const isAdmin = user?.role === "admin";
  const initialKey = sessionIdentity === null ? null : JSON.stringify([sessionIdentity, 1]);
  const initialCachedBookings = sessionIdentity === null ? null : getCachedOwnBookings(sessionIdentity, 1);
  const [items, setItems] = useState<Booking[]>(() => initialCachedBookings?.items ?? []);
  // Account that fetched the rendered rows. Rendered rows are always
  // scoped to the signed-in account: switching accounts clears them
  // immediately and late responses from the old account are discarded.
  const [loadedFor, setLoadedFor] = useState<string | null>(initialCachedBookings === null ? null : initialKey);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(initialCachedBookings?.total ?? 0);
  const [state, setState] = useState<"pending" | "ready" | "error" | "empty">(() =>
    initialCachedBookings === null ? "pending" : initialCachedBookings.items.length === 0 ? "empty" : "ready",
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [failureKey, setFailureKey] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    booking: Booking;
    token: string;
    ownerId: string;
  } | null>(null);
  const confirmationDialog = useRef<HTMLDialogElement | null>(null);
  const keepBookingButton = useRef<HTMLButtonElement | null>(null);
  const requestId = useRef(0);
  const retryCurrentLoad = useRef<() => void>(() => {});

  useEffect(() => {
    if (confirmationDialog.current?.open) confirmationDialog.current.close();
    setConfirmation(null);
    setItems([]);
    setLoadedFor(null);
    setPendingId(null);
    setPage(1);
  }, [sessionIdentity]);

  useEffect(() => {
    const dialog = confirmationDialog.current;
    if (dialog === null) return;
    if (confirmation === null || confirmation.ownerId !== userId) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
    keepBookingButton.current?.focus();
  }, [confirmation, userId]);

  // Fetches the rendered page. `keepRows` refreshes in place instead of
  // blanking the list first — used after a cancellation, where clearing
  // the rows reads as a full page reload.
  const load = useCallback(
    async ({
      keepFailure = false,
      keepRows = false,
    }: { keepFailure?: boolean; keepRows?: boolean } = {}) => {
      const token = getToken();
      const identity = sessionIdentity;
      if (token === null || identity === null) {
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
      const key = JSON.stringify([identity, page]);
      const cached = getCachedOwnBookings(identity, page);
      if (cached !== null) {
        setItems(cached.items);
        setTotal(cached.total);
        setLoadedFor(key);
        setFailure(null);
        setFailureKey(null);
        setState(cached.items.length === 0 ? "empty" : "ready");
        return;
      }
      if (!keepRows) {
        setItems([]);
        setTotal(0);
        setLoadedFor(null);
      }
      setState("pending");
      setFailureKey(null);
      if (!keepFailure) setFailure(null);
      const cacheRevision = getOwnBookingsCacheRevision();
      try {
        const body = await api.myBookings(token, page, PAGE_SIZE);
        if (requestId.current !== id || getToken() !== token || sessionIdentity !== identity) return;
        if (getOwnBookingsCacheRevision() !== cacheRevision) {
          retryCurrentLoad.current();
          return;
        }
        if (body.items.length === 0 && body.total > 0 && page > 1) {
          // The current page emptied under us (e.g. a cancellation on the
          // last page): step back instead of stranding the viewer.
          setPage(page - 1);
          return;
        }
        cacheOwnBookings(identity, page, body, cacheRevision);
        setItems(body.items);
        setTotal(body.total);
        setLoadedFor(key);
        setState(body.items.length === 0 ? "empty" : "ready");
      } catch (err: unknown) {
        if (requestId.current !== id || getToken() !== token || sessionIdentity !== identity) return;
        if (getOwnBookingsCacheRevision() !== cacheRevision) {
          retryCurrentLoad.current();
          return;
        }
        if (err instanceof ApiRequestError && err.status === 401) {
          markSessionExpired();
          setItems([]);
          setLoadedFor(null);
          setState("empty");
          return;
        }
        setState("error");
        setFailure(err instanceof ApiRequestError ? err.message : "Could not load bookings.");
        setFailureKey(key);
      }
    },
    [getToken, markSessionExpired, page, sessionIdentity],
  );
  retryCurrentLoad.current = () => void load();

  useEffect(() => {
    if (ready && !isAdmin) void load();
    else if (ready && isAdmin) setState("empty");
  }, [ready, load, isAdmin]);

  function dismissConfirmation() {
    if (confirmationDialog.current?.open) confirmationDialog.current.close();
    setConfirmation(null);
  }

  function requestCancellation(booking: Booking) {
    const token = getToken();
    if (token === null || userId === null || pendingId !== null || confirmation !== null) return;
    setConfirmation({ booking, token, ownerId: userId });
  }

  async function cancelConfirmed() {
    const request = confirmation;
    if (request === null || pendingId !== null) return;
    if (getToken() !== request.token || userId !== request.ownerId) {
      dismissConfirmation();
      return;
    }
    if (hasStarted(request.booking.event.starts_at, Date.now())) return;
    const { booking, token } = request;
    setPendingId(booking.id);
    dismissConfirmation();
    try {
      await api.cancelBooking(booking.id, token);
      invalidatePublicEventDetail(booking.event.id);
      invalidatePublicEventLists();
      if (sessionIdentity !== null) invalidateOwnBookings(sessionIdentity);
      // The account may have switched mid-flight: only the current
      // account's screen may refresh or show feedback. The new account's
      // own load (triggered by the switch) already covers its rows.
      if (getToken() !== token) return;
      await load({ keepRows: true });
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
        // message to the new account's own flows. The refresh keeps the
        // rows on screen so a failed cancel does not read as a reload
        // either.
        if (sessionIdentity !== null) invalidateOwnBookings(sessionIdentity);
        await load({ keepFailure: true, keepRows: true });
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

  const currentKey = sessionIdentity === null ? null : JSON.stringify([sessionIdentity, page]);
  const cachedBookings = sessionIdentity === null ? null : getCachedOwnBookings(sessionIdentity, page);
  const hasLoadedCurrentBookings = currentKey !== null && loadedFor === currentKey;
  const hasCurrentBookings = hasLoadedCurrentBookings || cachedBookings !== null;
  const visible = hasLoadedCurrentBookings ? items : cachedBookings?.items ?? [];
  const visibleTotal = hasLoadedCurrentBookings ? total : cachedBookings?.total ?? 0;
  const pages = Math.max(1, Math.ceil(visibleTotal / PAGE_SIZE));
  const confirmationStarted =
    confirmation !== null && hasStarted(confirmation.booking.event.starts_at, now);

  return (
    <main>
      <header className="page-heading">
        <h1>My bookings</h1>
        <p>Your plans, all in one place.</p>
      </header>
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
      {state === "pending" && <p className={hasCurrentBookings ? "refresh-status" : "empty-state"} role="status">{hasCurrentBookings ? "Updating bookings…" : "Loading bookings…"}</p>}
      {state === "error" && failureKey === currentKey && (
        <p role="alert">
          {failure}{" "}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      {state === "empty" && hasCurrentBookings && !isAdmin && user !== null && visible.length === 0 && visibleTotal === 0 && (
        <p className="empty-state">No bookings yet. Browse events to book a seat.</p>
      )}
      {visible.length > 0 && (
        <>
          <ul className="booking-list" aria-busy={state === "pending"}>
            {visible.map((booking) => {
              const started = hasStarted(booking.event.starts_at, now);
              return (
                <li key={booking.id} className="card">
                  <div className="booking-info">
                    <h2>
                      <Link href={`/events/${booking.event.id}`}>
                        {booking.event.title}
                      </Link>
                    </h2>
                    <p className="muted">
                      <time dateTime={booking.event.starts_at} title={NEPAL_LABEL}>{formatNepal(booking.event.starts_at)}</time>
                    </p>
                    <p className="muted">{booking.event.venue}</p>
                    <span className="status-label">Booked</span>
                  </div>
                  <div className="booking-actions">
                    <button
                      type="button"
                      disabled={pendingId !== null || started}
                      onClick={() => requestCancellation(booking)}
                    >
                      {pendingId === booking.id ? "Cancelling…" : "Cancel booking"}
                    </button>
                    {started && (
                      <p className="muted">
                        This event has already started; it can no longer be cancelled.
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="pagination">
            <p className="muted">
              Page {page} of {pages} ({visibleTotal} bookings)
            </p>
            {pages > 1 && (
              <p className="button-row">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </button>{" "}
                <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  Next
                </button>
              </p>
            )}
          </div>
        </>
      )}
      {hasCurrentBookings && visible.length === 0 && pages > 1 && (
        <p>
          <button type="button" onClick={() => setPage(1)}>
            Back to first page
          </button>
        </p>
      )}
      {failure !== null && state !== "error" && <p role="alert">{failure}</p>}
      {confirmation !== null && (
        <dialog
          ref={confirmationDialog}
          className="confirmation-dialog"
          role="alertdialog"
          aria-labelledby="cancel-booking-title"
          aria-describedby="cancel-booking-description"
          onCancel={(event) => {
            event.preventDefault();
            dismissConfirmation();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              dismissConfirmation();
            }
          }}
        >
          <h2 id="cancel-booking-title">Cancel booking?</h2>
          <p id="cancel-booking-description">
            Are you sure you want to cancel this booking?
          </p>
          <div className="button-row">
            {confirmationStarted && (
              <p className="muted">
                This event has already started; it can no longer be cancelled.
              </p>
            )}
            <button
              ref={keepBookingButton}
              type="button"
              onClick={dismissConfirmation}
            >
              Keep booking
            </button>
            <button
              type="button"
              disabled={pendingId !== null || confirmationStarted}
              onClick={() => void cancelConfirmed()}
            >
              Cancel booking
            </button>
          </div>
        </dialog>
      )}
      <p className="timezone-note">All times shown in {NEPAL_LABEL}.</p>
      <p className="return-link">
        <Link href="/">Back to events</Link>
      </p>
    </main>
  );
}
