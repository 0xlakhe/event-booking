"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { ApiRequestError, api, type EventDetail } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { NEPAL_LABEL, formatNepal } from "../../../lib/datetime";
import { hasStarted, useNow } from "../../../lib/clock";
import { getCachedPublicEventDetail, invalidatePublicEventDetail, loadPublicEventDetail } from "../../../lib/public_event_cache";
import { getEventListOriginForEvent, invalidatePublicEventLists } from "../../../lib/event_list_navigation";
import { invalidateOwnBookings } from "../../../lib/own_bookings_cache";

type BookingPhase =
  | { kind: "idle" }
  | { kind: "booking" }
  | { kind: "verifying"; message: string }
  | { kind: "failed"; message: string };

function friendlyBookingError(code: string, fallback: string): string {
  switch (code) {
    case "ALREADY_BOOKED":
      return "You already have an active booking for this event.";
    case "EVENT_FULL":
      return "This event just filled up. No seat was booked.";
    case "EVENT_STARTED":
      return "This event has already started and can no longer be booked.";
    case "NOT_FOUND":
      return "This event no longer exists.";
    case "ADMIN_BOOKING_FORBIDDEN":
      return "Booking actions are not available to administrators.";
    default:
      return fallback;
  }
}

const HISTORY_PAGE_SIZE = 10;

/** Scan every history page for an active booking on this event. A
 * definitive "absent" is only returned after the whole history has been
 * checked, because a single page of rows cannot rule a booking out. */
async function findActiveBooking(
  token: string,
  eventId: string,
): Promise<"confirmed" | "absent"> {
  let page = 1;
  for (;;) {
    const history = await api.myBookings(token, page, HISTORY_PAGE_SIZE);
    if (
      history.items.some(
        (booking) => booking.event.id === eventId,
      )
    ) {
      return "confirmed";
    }
    if (history.items.length === 0 || page * HISTORY_PAGE_SIZE >= history.total) {
      return "absent";
    }
    page += 1;
  }
}

export default function EventDetailPage() {
  return (
    <Suspense fallback={<EventDetailLoading />}>
      <Detail />
    </Suspense>
  );
}

function EventDetailLoading() {
  return (
    <main>
      <p className="sr-only" role="status">Loading event details…</p>
      <div className="detail-loading" data-testid="event-detail-skeleton" aria-busy="true" aria-hidden="true">
        <div className="skeleton-line skeleton-back-link" />
        <div className="detail-grid">
          <div className="detail-copy">
            <div className="skeleton-line skeleton-heading" />
            <div className="skeleton-description">
              <div className="skeleton-line" />
              <div className="skeleton-line" />
              <div className="skeleton-line" />
              <div className="skeleton-line" />
              <div className="skeleton-line skeleton-description-short" />
            </div>
          </div>
          <aside className="booking-panel skeleton-booking-panel">
            <div className="skeleton-fact">
              <div className="skeleton-line skeleton-fact-label" />
              <div className="skeleton-line skeleton-fact-value" />
            </div>
            <div className="skeleton-fact">
              <div className="skeleton-line skeleton-fact-label" />
              <div className="skeleton-line skeleton-fact-value skeleton-fact-value-short" />
            </div>
            <div className="skeleton-fact">
              <div className="skeleton-line skeleton-fact-label" />
              <div className="skeleton-line skeleton-fact-value skeleton-fact-value-short" />
            </div>
            <div className="skeleton-line skeleton-booking-action" />
          </aside>
        </div>
      </div>
    </main>
  );
}

function Detail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { user, ready, getToken, markSessionExpired, sessionIdentity } = useAuth();
  const now = useNow();
  const [event, setEvent] = useState<EventDetail | null>(() => getCachedPublicEventDetail(id));
  const [loadedEventId, setLoadedEventId] = useState<string | null>(() => event === null ? null : id);
  const [state, setState] = useState<"pending" | "ready" | "error">("pending");
  const [failure, setFailure] = useState<string | null>(null);
  const [failureEventId, setFailureEventId] = useState<string | null>(null);
  const [phase, setPhase] = useState<BookingPhase>({ kind: "idle" });
  const [booked, setBooked] = useState(false);
  const requestId = useRef(0);
  const loadedEventIdRef = useRef<string | null>(loadedEventId);
  const bookingInFlight = useRef(false);
  const scanId = useRef(0);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    const cached = getCachedPublicEventDetail(id);
    if (cached !== null && loadedEventIdRef.current !== id) {
      setEvent(cached);
      setLoadedEventId(id);
      loadedEventIdRef.current = id;
    }
    setState("pending");
    setFailure(null);
    setFailureEventId(null);
    try {
      const detail = await loadPublicEventDetail(id);
      if (requestId.current !== current) return;
      setEvent(detail);
      setLoadedEventId(id);
      loadedEventIdRef.current = id;
      setState("ready");
    } catch (err: unknown) {
      if (requestId.current !== current) return;
      if (err instanceof ApiRequestError && err.code === "NOT_FOUND") {
        invalidatePublicEventDetail(id);
        setEvent(null);
        setLoadedEventId(null);
        loadedEventIdRef.current = null;
        setFailureEventId(null);
        router.replace(getEventListOriginForEvent(id)?.href ?? "/");
        return;
      }
      setFailure("Could not load this event.");
      setFailureEventId(id);
      setState("error");
    }
  }, [id, router]);

  /** Load-time check for this account's own active booking on the event,
   * so a booked event is recognized after a reload. Errors leave the
   * action as "not booked"; a later ALREADY_BOOKED response repairs the
   * state, so this check never blocks the explicit action. */
  const refreshBooked = useCallback(async () => {
    const token = getToken();
    if (token === null) return;
    const scan = ++scanId.current;
    try {
      const outcome = await findActiveBooking(token, id);
      if (scanId.current !== scan || getToken() !== token) return;
      if (outcome === "confirmed") setBooked(true);
    } catch {
      // Unknown: keep the action available rather than blocking on it. A
      // scan 401 deliberately does not trigger the app-wide expiry
      // redirect; the next authenticated action still expires the session
      // through the existing paths.
    }
  }, [getToken, id]);

  useEffect(() => {
    // Same restoration rule as the listing: admins manage in /admin and
    // must not be redirected before hydration determines their role.
    if (!ready) return;
    if (user?.role === "admin") {
      router.replace("/admin");
      return;
    }
    void load();
    if (user !== null) void refreshBooked();
  }, [ready, user, load, refreshBooked, router]);

  useEffect(() => {
    // A different account (or a sign-out) owns the screen now: drop any
    // transient booking phase, in-flight guard, and booked marker left
    // by the old one.
    setPhase({ kind: "idle" });
    bookingInFlight.current = false;
    setBooked(false);
  }, [user?.id, id]);

  async function book() {
    const token = getToken();
    if (token === null) {
      router.push("/login");
      return;
    }
    if (event === null || state !== "ready" || bookingInFlight.current) return;
    bookingInFlight.current = true;
    setPhase({ kind: "booking" });
    try {
      await api.createBooking(event.id, token);
      invalidatePublicEventDetail(event.id);
      invalidatePublicEventLists();
      if (sessionIdentity !== null) invalidateOwnBookings(sessionIdentity);
      // A switch or sign-out while the POST was in flight owns the screen
      // now: the old session's outcome must not touch the new one.
      if (getToken() !== token) return;
      setBooked(true);
      setPhase({ kind: "idle" });
      await load();
    } catch (err: unknown) {
      invalidatePublicEventDetail(event.id);
      invalidatePublicEventLists();
      if (sessionIdentity !== null) invalidateOwnBookings(sessionIdentity);
      if (getToken() !== token) return;
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        router.push("/login");
        return;
      }
      if (err instanceof ApiRequestError) {
        // Backend decision (full/duplicate/started): authoritative, no retry.
        // A duplicate is also the repair signal for the load-time check.
        if (err.code === "ALREADY_BOOKED") setBooked(true);
        setPhase({ kind: "failed", message: friendlyBookingError(err.code, err.message) });
        await load();
        return;
      }
      // The request may have committed server-side despite the failure:
      // never retry blindly. Scan the account's whole history first, so a
      // confirmed booking is recognized and absence is only asserted once
      // every page has been checked.
      setPhase({
        kind: "verifying",
        message: "The booking may have gone through. Checking your bookings…",
      });
      try {
        const outcome = await findActiveBooking(token, event.id);
        if (getToken() !== token) return;
        if (outcome === "confirmed") {
          setBooked(true);
          setPhase({ kind: "idle" });
          await load();
        } else {
          setPhase({
            kind: "failed",
            message: "Booking failed with a network error. Nothing was booked — try again.",
          });
          await load();
        }
      } catch (recoveryErr: unknown) {
        if (getToken() !== token) return;
        if (recoveryErr instanceof ApiRequestError && recoveryErr.status === 401) {
          // The initiating session is still current, so its 401 is real.
          markSessionExpired();
          router.push("/login");
          return;
        }
        setPhase({
          kind: "failed",
          message:
            "We couldn't confirm whether the booking went through. Check your bookings before trying again.",
        });
      }
    } finally {
      // Only the session that started this booking may clear its guard; a
      // replaced session's flag belongs to the new session now.
      if (getToken() === token) bookingInFlight.current = false;
    }
  }

  const hasCurrentEvent = event !== null && loadedEventId === id;
  const hasCurrentFailure = state === "error" && failureEventId === id;
  const isRefreshing = hasCurrentEvent && state === "pending";
  const listOrigin = getEventListOriginForEvent(id);

  function handleBackToEvents(click: MouseEvent<HTMLAnchorElement>) {
    if (listOrigin === null || click.defaultPrevented || click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    router.back();
  }

  if (!hasCurrentEvent && !hasCurrentFailure) {
    return <EventDetailLoading />;
  }
  if (!hasCurrentEvent || event === null) {
    return (
      <main>
        <p role="alert">
          {failure ?? "Could not load this event."}{" "}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
        <p>
          <Link href={listOrigin?.href ?? "/"} onClick={handleBackToEvents}>Back to events</Link>
        </p>
      </main>
    );
  }

  const full = event.seats_left <= 0;
  const started = hasStarted(event.starts_at, now);
  const bookLabel =
    phase.kind === "booking"
      ? "Booking…"
      : booked
        ? "Booked"
        : state === "pending"
          ? "Checking availability…"
          : state === "error"
            ? "Availability unavailable"
            : started
              ? "Event started"
              : full
                ? "Event full"
                : "Book one seat";

  const freshAvailability = state === "ready";

  return (
    <main>
      {isRefreshing && <p className="sr-only" role="status">Updating availability…</p>}
      {hasCurrentFailure && (
        <p role="alert">
          {failure ?? "Could not refresh this event."}{" "}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      <Link className="back-link" href={listOrigin?.href ?? "/"} onClick={handleBackToEvents}>Back to events</Link>
      <div className="detail-grid" aria-busy={isRefreshing}>
        <div className="detail-copy">
          <h1>{event.title}</h1>
          <p className="event-description">{event.description}</p>
        </div>
        <aside className="booking-panel" aria-label="Event details and booking">
          <dl className="event-facts">
            <div><dt>When</dt><dd><time dateTime={event.starts_at} title={NEPAL_LABEL}>{formatNepal(event.starts_at)}</time></dd></div>
            <div><dt>Where</dt><dd>{event.venue}</dd></div>
          <div><dt>Availability</dt><dd>{freshAvailability ? `${event.seats_left} / ${event.total_seats} seats left` : state === "pending" ? "Updating availability…" : "Availability could not be refreshed."}</dd></div>
          </dl>
          <p className="timezone-note">All times shown in {NEPAL_LABEL}.</p>

          {ready && user === null && (
            <p>
              <Link className="button button-primary" href="/login">Log in</Link> <span className="booking-signin-note">to book a seat.</span>
            </p>
          )}
          {ready && user !== null && user.role !== "admin" && (
            <p>
              <button
                className="button-primary"
                type="button"
                disabled={!freshAvailability || phase.kind === "booking" || phase.kind === "verifying" || booked || full || started}
                onClick={() => void book()}
              >
                {bookLabel}
              </button>
            </p>
          )}
          {freshAvailability && started && !booked && (
            <p className="muted">
              This event has already started and can no longer be booked.
            </p>
          )}
          {phase.kind === "verifying" && <p role="status">{phase.message}</p>}
          {phase.kind === "failed" && <p role="alert">{phase.message}</p>}
        </aside>
      </div>
    </main>
  );
}
