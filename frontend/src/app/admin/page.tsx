"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import EventForm, { type EventFormValues } from "../../components/event-form";
import EventDescription from "../../components/event-description";
import { ApiRequestError, adminApi, api, type Attendee, type EventDetail, type TimeFilter } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { NEPAL_LABEL, formatNepal } from "../../lib/datetime";

const PAGE_SIZE = 10;

const TIME_FILTERS: { value: TimeFilter; label: string }[] = [
  { value: "upcoming", label: "Upcoming" },
  { value: "past", label: "Past" },
  { value: "all", label: "All" },
];

function parseTimeFilter(raw: string | null): TimeFilter {
  // Unknown or missing URL values fall back to the default filter.
  return raw === "past" || raw === "all" ? raw : "upcoming";
}

function adminErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case "CAPACITY_BELOW_BOOKINGS":
      return "Total seats cannot go below the number already booked.";
    case "EVENT_HAS_BOOKINGS":
      return "This event still has active bookings and cannot be deleted. Cancel them first.";
    case "EVENT_STARTED":
      return "This event has already started and is read-only history now.";
    case "NOT_FOUND":
      return "This event no longer exists.";
    default:
      return fallback;
  }
}

function isStarted(startsAt: string): boolean {
  // Display gating only; the backend re-checks fresh database time and
  // stays authoritative for every mutation.
  return new Date(startsAt).getTime() <= Date.now();
}

export default function AdminPage() {
  return (
    <Suspense fallback={<p>Loading admin…</p>}>
      <Admin />
    </Suspense>
  );
}

function Admin() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, ready, getToken, markSessionExpired, error: authError, clearError } = useAuth();
  const query = params.get("q") ?? "";
  const timeFilter = parseTimeFilter(params.get("time_filter"));
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);

  const [items, setItems] = useState<EventDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"pending" | "ready" | "error" | "empty">("pending");
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState(query);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EventDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [attendeesFor, setAttendeesFor] = useState<string | null>(null);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [attendeesTotal, setAttendeesTotal] = useState(0);
  const [attendeesPage, setAttendeesPage] = useState(1);
  const listRequestId = useRef(0);
  const attendeesRequestId = useRef(0);

  useEffect(() => setDraft(query), [query]);

  const load = useCallback(async () => {
    const token = getToken();
    if (token === null) {
      // Invalidate any in-flight responses too, so a pre-sign-out
      // request landing late cannot repopulate the cleared list.
      listRequestId.current += 1;
      setItems([]);
      setState("empty");
      return;
    }
    const id = ++listRequestId.current;
    setState("pending");
    setFailure(null);
    try {
      const body = await adminApi.listEvents(token, query, timeFilter, page, PAGE_SIZE);
      if (listRequestId.current !== id) return;
      setItems(body.items);
      setTotal(body.total);
      setState(body.items.length === 0 ? "empty" : "ready");
    } catch (err: unknown) {
      if (listRequestId.current !== id) return;
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        setItems([]);
        setState("empty");
        return;
      }
      setState("error");
      setFailure(err instanceof ApiRequestError ? err.message : "Could not load events.");
    }
  }, [getToken, markSessionExpired, query, timeFilter, page]);

  useEffect(() => {
    if (ready && user?.role === "admin") void load();
  }, [ready, user, load]);

  const loadAttendees = useCallback(
    async (eventId: string, attendeesPageNumber: number) => {
      const token = getToken();
      if (token === null) return;
      const id = ++attendeesRequestId.current;
      try {
        const body = await adminApi.attendees(token, eventId, attendeesPageNumber, PAGE_SIZE);
        if (attendeesRequestId.current !== id) return;
        setAttendees(body.items);
        setAttendeesTotal(body.total);
        setAttendeesPage(attendeesPageNumber);
        setAttendeesFor(eventId);
      } catch (err: unknown) {
        if (attendeesRequestId.current !== id) return;
        if (err instanceof ApiRequestError && err.status === 401) {
          markSessionExpired();
          return;
        }
        setFailure(
          err instanceof ApiRequestError
            ? adminErrorMessage(err.code, err.message)
            : "Could not load attendees.",
        );
      }
    },
    [getToken, markSessionExpired],
  );

  async function startEdit(eventId: string) {
    setFailure(null);
    try {
      setEditing(await api.getEvent(eventId));
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        return;
      }
      setFailure(
        err instanceof ApiRequestError
          ? adminErrorMessage(err.code, err.message)
          : "Could not load this event.",
      );
    }
  }

  async function save(values: EventFormValues) {
    const token = getToken();
    if (token === null) return;
    setSaving(true);
    setFailure(null);
    try {
      if (editing === null) {
        await adminApi.createEvent(token, values);
        setCreating(false);
      } else {
        await adminApi.updateEvent(token, editing.id, values);
        setEditing(null);
      }
      await load();
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        return;
      }
      setFailure(
        err instanceof ApiRequestError
          ? adminErrorMessage(err.code, err.message)
          : "Saving failed. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function remove(eventId: string) {
    const token = getToken();
    if (token === null || saving) return;
    if (!window.confirm("Delete this event? Cancelled booking history goes with it.")) return;
    setSaving(true);
    setFailure(null);
    try {
      await adminApi.deleteEvent(token, eventId);
      if (attendeesFor === eventId) setAttendeesFor(null);
      await load();
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.status === 401) {
        markSessionExpired();
        return;
      }
      setFailure(
        err instanceof ApiRequestError
          ? adminErrorMessage(err.code, err.message)
          : "Deletion failed. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  function navigate(nextQuery: string, nextFilter: TimeFilter, nextPage: number) {
    // Filter and page live in the URL so refresh and back/forward restore
    // them; the default filter stays implicit for clean links.
    const searchParams = new URLSearchParams();
    if (nextQuery !== "") searchParams.set("q", nextQuery);
    if (nextFilter !== "upcoming") searchParams.set("time_filter", nextFilter);
    if (nextPage > 1) searchParams.set("page", String(nextPage));
    const suffix = searchParams.toString();
    router.push(suffix === "" ? "/admin" : `/admin?${suffix}`);
  }

  function search(next: string) {
    navigate(next.trim(), timeFilter, 1);
  }

  function go(nextPage: number) {
    navigate(query, timeFilter, nextPage);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const attendeePages = Math.max(1, Math.ceil(attendeesTotal / PAGE_SIZE));

  return (
    <main>
      <h1>Admin events</h1>
      {ready && authError !== null && (
        <p role="alert">
          {authError}{" "}
          <button type="button" onClick={clearError}>
            Dismiss
          </button>
        </p>
      )}
      {!ready && <p>Loading…</p>}
      {ready && user === null && (
        <p>
          <Link href="/login">Log in</Link> as an admin to manage events.
        </p>
      )}
      {ready && user !== null && user.role !== "admin" && (
        <p role="alert">
          Admin access required. Backend protections remain authoritative — this page
          discloses nothing without an admin session.
        </p>
      )}
      {ready && user?.role === "admin" && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setDraft(draft);
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
            <button type="submit">Search</button>{" "}
            {!creating && editing === null && (
              <button type="button" onClick={() => setCreating(true)}>
                New event
              </button>
            )}
          </form>

          <div role="group" aria-label="Filter events by time">
            {TIME_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={timeFilter === option.value}
                onClick={() => {
                  if (timeFilter !== option.value) navigate(query, option.value, 1);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>

          {state === "pending" && <p>Loading events…</p>}
          {state === "error" && (
            <p role="alert">
              {failure}{" "}
              <button type="button" onClick={() => void load()}>
                Retry
              </button>
            </p>
          )}
          {state === "empty" && <p>No events found.</p>}
          {failure !== null && state !== "error" && <p role="alert">{failure}</p>}

          {creating && (
            <div className="card">
              <h2>New event</h2>
              <EventForm
                pending={saving}
                failure={null}
                submitLabel="Create event"
                onSubmit={(values) => void save(values)}
                onCancel={() => setCreating(false)}
              />
            </div>
          )}

          <ul>
            {items.map((event) => (
              <li key={event.id} className="card">
                <strong>{event.title}</strong>
                <br />
                <span className="muted">
                  {event.venue} ·{" "}
                  <span title={NEPAL_LABEL}>{formatNepal(event.starts_at)}</span> ·{" "}
                  {event.seats_left} / {event.total_seats} seats left
                </span>
                <EventDescription key={event.description} description={event.description} />
                {editing?.id === event.id ? (
                  <EventForm
                    initial={editing}
                    pending={saving}
                    failure={null}
                    submitLabel="Save changes"
                    onSubmit={(values) => void save(values)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <>
                    {!isStarted(event.starts_at) && (
                      <p>
                        <button type="button" disabled={saving} onClick={() => void startEdit(event.id)}>
                          Edit
                        </button>{" "}
                        <button type="button" disabled={saving} onClick={() => void remove(event.id)}>
                          Delete
                        </button>
                      </p>
                    )}
                    <p>
                      <button
                        type="button"
                        onClick={() => {
                          if (attendeesFor === event.id) setAttendeesFor(null);
                          else void loadAttendees(event.id, 1);
                        }}
                      >
                        {attendeesFor === event.id ? "Hide attendees" : "Attendees"}
                      </button>
                    </p>
                  </>
                )}
                {attendeesFor === event.id && (
                  <div>
                    <h3>Attendees ({attendeesTotal})</h3>
                    {attendees.length === 0 && <p className="muted">No active bookings.</p>}
                    <ul>
                      {attendees.map((entry) => (
                        <li key={entry.booking_id}>
                          {entry.user.email} ·{" "}
                          <span title={NEPAL_LABEL}>{formatNepal(entry.booked_at)}</span>
                        </li>
                      ))}
                    </ul>
                    {attendeePages > 1 && (
                      <p>
                        <button
                          type="button"
                          disabled={attendeesPage <= 1}
                          onClick={() => void loadAttendees(event.id, attendeesPage - 1)}
                        >
                          Previous
                        </button>{" "}
                        <button
                          type="button"
                          disabled={attendeesPage >= attendeePages}
                          onClick={() => void loadAttendees(event.id, attendeesPage + 1)}
                        >
                          Next
                        </button>
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="muted">
            Page {page} of {pages} ({total} events)
          </p>
          <p>
            <button type="button" disabled={page <= 1} onClick={() => go(page - 1)}>
              Previous
            </button>{" "}
            <button type="button" disabled={page >= pages} onClick={() => go(page + 1)}>
              Next
            </button>
          </p>
          <p className="muted">All times shown in {NEPAL_LABEL}.</p>
        </>
      )}
    </main>
  );
}
