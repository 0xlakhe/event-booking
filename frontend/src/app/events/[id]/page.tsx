"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, api, type EventDetail } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { NEPAL_LABEL, formatNepal } from "../../../lib/datetime";
import { hasStarted, useNow } from "../../../lib/clock";

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
  for (; ;) {
    const history = await api.myBookings(token, page, HISTORY_PAGE_SIZE);
    if (
      history.items.some(
        (booking) => booking.event.id === eventId && booking.cancelled_at === null,
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
    <Suspense fallback={<main><p className="empty-state" role="status">Loading event…</p></main>}>
      <Detail />
    </Suspense>
  );
}

function Detail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { user, ready, getToken, markSessionExpired } = useAuth();
  const now = useNow();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [state, setState] = useState<"pending" | "ready" | "error">("pending");
  const [phase, setPhase] = useState<BookingPhase>({ kind: "idle" });
  const requestId = useRef(0);
  const bookingInFlight = useRef(false);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setState("pending");
    try {
      const detail = await api.getEvent(id);
      if (requestId.current !== current) return;
      setEvent(detail);
      setState("ready");
    } catch (err: unknown) {
      if (requestId.current !== current) return;
      if (err instanceof ApiRequestError && err.code === "NOT_FOUND") {
        router.replace("/");
        return;
      }
      setState("error");
    }
  }, [id, router]);

  useEffect(() => {
    // Same restoration rule as the listing: admins manage in /admin and
    // must not be redirected before hydration determines their role.
    if (!ready) return;
    if (user?.role === "admin") {
      router.replace("/admin");
      return;
    }
    void load();
  }, [ready, user, load, router]);

  useEffect(() => {
    // A different account (or a sign-out) owns the screen now: drop any
    // transient booking phase and in-flight guard left by the old one.
    setPhase({ kind: "idle" });
    bookingInFlight.current = false;
  }, [user?.id]);

  async function book() {
    const token = getToken();
    if (token === null) {
      router.push("/login");
      return;
    }
    if (event === null || bookingInFlight.current) return;
    bookingInFlight.current = true;
    setPhase({ kind: "booking" });
    try {
      await api.createBooking(event.id, token);
      // A switch or sign-out while the POST was in flight owns the screen
      // now: the old session's outcome must not touch the new one.
      if (getToken() !== token) return;
      setPhase({ kind: "idle" });
      await load();
    } catch (err: unknown) {
      if (getToken() !== token) return;
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        router.push("/login");
        return;
      }
      if (err instanceof ApiRequestError) {
        // Backend decision (full/duplicate/started): authoritative, no retry.
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

  if (state === "pending") return <main><p className="empty-state" role="status">Loading event…</p></main>;
  if (state === "error" || event === null) {
    return (
      <main>
        <p role="alert">
          Could not load this event.{" "}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
        <p>
          <Link href="/">Back to events</Link>
        </p>
      </main>
    );
  }

  const full = event.seats_left <= 0;
  const started = hasStarted(event.starts_at, now);
  const bookLabel =
    phase.kind === "booking"
      ? "Booking…"
      : started
        ? "Event started"
        : full
          ? "Event full"
          : "Book one seat";

  return (
    <main>
      <Link className="back-link" href="/">Back to events</Link>
      <div className="detail-grid">
        <div className="detail-copy">
          <h1>{event.title}</h1>
          <p className="event-description">{event.description}</p>
        </div>
        <aside className="booking-panel" aria-label="Event details and booking">
          <dl className="event-facts">
            <div><dt>When</dt><dd><time dateTime={event.starts_at} title={NEPAL_LABEL}>{formatNepal(event.starts_at)}</time></dd></div>
            <div><dt>Where</dt><dd>{event.venue}</dd></div>
            <div><dt>Availability</dt><dd>{event.seats_left} / {event.total_seats} seats left</dd></div>
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
                disabled={phase.kind === "booking" || phase.kind === "verifying" || full || started}
                onClick={() => void book()}
              >
                {bookLabel}
              </button>
            </p>
          )}
          {started && (
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
